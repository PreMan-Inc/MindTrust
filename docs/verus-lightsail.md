# Dedicated Verus Lightsail host

Deployment preparation only: these files do not create AWS resources or establish that `verus.preman.live` is live. The approved topology is a dedicated 4 GiB Linux instance, static IPv4 address, and 20 GiB attached disk, with snapshot charges additional. Confirm the selected bundle's current price remains within the approved approximately $26/month total before creating resources.

Use resource names `verus-prod`, `verus-prod-ip`, and `verus-data`, region `us-east-1`, one available zone in that region, and tags `Application=Verus,Environment=production`. This procedure does not change PreMan's existing API, load balancer, networking, or DNS records. It requires existing AWS permissions; stop on `AccessDenied` instead of changing IAM policies or creating access keys.

## 1. Inspect the signed-in AWS account and provision only missing resources

In AWS CloudShell, disable shell tracing and use private file permissions. Never enable CLI debug output or print SSH-access responses, environment files, or resolved Compose configuration.

```sh
set +x
umask 077
export AWS_PAGER=''
verus_region=us-east-1
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}'
aws lightsail get-regions --include-availability-zones --query 'regions[?name==`us-east-1`].availabilityZones'
aws lightsail get-bundles --region "$verus_region" --query 'bundles[?ramSizeInGb==`4` && isActive==`true`].{id:bundleId,price:price,platforms:supportedPlatforms,disk:diskSizeInGb}'
aws lightsail get-blueprints --region "$verus_region" --query 'blueprints[?isActive==`true`].{id:blueprintId,name:name,version:version}'
aws lightsail get-instance --region "$verus_region" --instance-name verus-prod --query 'instance.{name:name,state:state.name,zone:location.availabilityZone,bundle:bundleId,blueprint:blueprintId,tags:tags}'
aws lightsail get-disk --region "$verus_region" --disk-name verus-data
aws lightsail get-static-ip --region "$verus_region" --static-ip-name verus-prod-ip
```

Select an active Ubuntu 24.04 blueprint and the approved 4 GiB Linux/IPv4 bundle from the actual results. Set `verus_zone`, `verus_blueprint`, and `verus_bundle` accordingly. Treat only an explicit resource-not-found response as absence. For existing resources, confirm names, tags, size, zone, and attachment before reuse; do not detach, reformat, or replace anything on a mismatch.

Run each applicable command once, only for the missing/unattached dedicated resource. Inspect the returned operation and wait for successful completion before its dependent step. Record the resource/operation names to resume from read-only inspection after a disconnect.

```sh
aws lightsail create-instances --region "$verus_region" --instance-names verus-prod --availability-zone "$verus_zone" --blueprint-id "$verus_blueprint" --bundle-id "$verus_bundle" --ip-address-type ipv4 --tags key=Application,value=Verus key=Environment,value=production
aws lightsail allocate-static-ip --region "$verus_region" --static-ip-name verus-prod-ip
aws lightsail attach-static-ip --region "$verus_region" --static-ip-name verus-prod-ip --instance-name verus-prod
aws lightsail create-disk --region "$verus_region" --disk-name verus-data --availability-zone "$verus_zone" --size-in-gb 20 --tags key=Application,value=Verus key=Environment,value=production
```

Before attaching, record the instance's `lsblk` inventory over SSH. Then attach `verus-data` to `verus-prod` with `aws lightsail attach-disk --region "$verus_region" --disk-name verus-data --instance-name verus-prod --disk-path /dev/xvdf`. The guest device name must be verified afterward; do not assume `/dev/xvdf` is the actual device. Lightsail attached disks and snapshots are [encrypted by default](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-block-storage.html).

For this instance only, use `put-instance-public-ports` with TCP 80/443 open publicly and TCP 22 restricted to the current CloudShell outbound IPv4 `/32` (optionally also `cidrListAliases:["lightsail-connect"]` for Lightsail browser SSH). Obtain that outbound address from `https://checkip.amazonaws.com`. Supply a reviewed JSON file with all three rules using `--port-infos file://verus-ports.json`; this API [replaces the instance's firewall rules](https://docs.aws.amazon.com/cli/latest/reference/lightsail/put-instance-public-ports.html). Do not expose 4310 or the Docker socket. Refresh the SSH source rule if CloudShell's address changes.

## 2. Use temporary SSH credentials without exposing them

CloudShell already uses the signed-in AWS identity. [Temporary Lightsail SSH credentials](https://docs.aws.amazon.com/cli/latest/reference/lightsail/get-instance-access-details.html) avoid importing a new long-lived key or installing AWS credentials on the VM:

```sh
verus_access_dir=$(mktemp -d)
aws lightsail get-instance-access-details --region "$verus_region" --instance-name verus-prod --protocol ssh > "$verus_access_dir/access.json"
jq -r '.accessDetails.privateKey' "$verus_access_dir/access.json" > "$verus_access_dir/key"
jq -r '.accessDetails.certKey' "$verus_access_dir/access.json" > "$verus_access_dir/key-cert.pub"
jq -r '.accessDetails as $a | $a.hostKeys[] | "\($a.ipAddress) \(.algorithm) \(.publicKey)"' "$verus_access_dir/access.json" > "$verus_access_dir/known_hosts"
verus_ip=$(jq -r '.accessDetails.ipAddress' "$verus_access_dir/access.json")
verus_user=$(jq -r '.accessDetails.username' "$verus_access_dir/access.json")
test -s "$verus_access_dir/known_hosts"
ssh -i "$verus_access_dir/key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$verus_access_dir/known_hosts" "$verus_user@$verus_ip"
```

OpenSSH reads the matching `key-cert.pub` automatically. Renew expired access details through AWS. Preserve strict host verification; do not substitute `StrictHostKeyChecking=no`. Delete only the temporary access directory when finished. Keep application/bootstrap secrets out of instance user data, shell history, and terminal output.

## 3. Prepare and identify the encrypted filesystem

On the new VM, compare `lsblk -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,SERIAL` before/after attachment with the Lightsail disk metadata. Confirm exactly one new 20 GiB device, no mount/partitions/filesystem signatures, and that it is not the root device or its parent. Use `sudo wipefs --no-act DEVICE` and `sudo blkid DEVICE` to inspect signatures. If ambiguous, stop; no included script formats disks.

Only for that verified new, empty device, create ext4 with `sudo mkfs.ext4 DEVICE` (no force option). Existing disks must retain their filesystem/data. Record `sudo blkid -s UUID -o value DEVICE`. Set the actual verified UUID in `verus_disk_uuid` and create `/srv/verus-data`. Add exactly one UUID-based entry to `/etc/fstab`, preserving other entries:

```text
UUID=ACTUAL_VERIFIED_UUID /srv/verus-data ext4 defaults,nofail 0 2
```

Mount with `sudo mount /srv/verus-data`, verify the UUID with `findmnt -nr -M /srv/verus-data -o UUID,FSTYPE`, then record it in a root-owned file:

```sh
sudo install -d -m 0755 /etc/verus
printf '%s\n' "$verus_disk_uuid" | sudo tee /etc/verus/data-disk.uuid >/dev/null
sudo chmod 0644 /etc/verus/data-disk.uuid
sudo install -d -o 1000 -g 1000 -m 0700 /srv/verus-data/workspace /srv/verus-data/backups
sudo install -d -o root -g root -m 0700 /srv/verus-data/private /srv/verus-data/caddy-data /srv/verus-data/caddy-config
```

The Dockerfile's `node` user is UID/GID 1000. Install Docker Engine and its Compose plugin from [Docker's official Ubuntu apt repository](https://docs.docker.com/engine/install/ubuntu/). Use `sudo docker`; adding operators to the Docker group grants root-equivalent access and is not required here.

## 4. Install the release and mount guard before starting the app

Build a source archive from the exact reviewed Git commit (`git archive --format=tar COMMIT | gzip -n`), record its SHA-256, upload it into CloudShell, and transfer it with the same verified SSH identity. Verify the checksum on the VM before extraction. The archive must exclude local databases, credentials, `.env`, and evaluation artifacts; do not upload the entire working directory or install GitHub credentials on the host.

Extract into a new root-owned `/opt/verus/releases/COMMIT` directory and point `/opt/verus/current` to that release. Keep the previous release/image for rollback. From that release:

```sh
sudo install -m 0755 deploy/verus-require-data-disk.sh /usr/local/sbin/verus-require-data-disk
sudo install -m 0755 deploy/verus-backup.sh /usr/local/sbin/verus-backup
sudo install -d -m 0755 /etc/systemd/system/docker.service.d
sudo install -m 0644 deploy/systemd/verus-docker-mount.conf /etc/systemd/system/docker.service.d/verus-data.conf
sudo install -m 0644 deploy/systemd/verus-backup.service deploy/systemd/verus-backup.timer /etc/systemd/system/
sudo /usr/local/sbin/verus-require-data-disk
sudo systemctl daemon-reload
sudo systemctl restart docker
```

The guard requires the recorded UUID, ext4, an actual filesystem mount, and a root-owned UUID file. `RequiresMountsFor` orders Docker after the mount; `BindsTo` stops Docker when the mount unit goes away. The guard is deliberately on **Docker itself**, since its persisted `restart: unless-stopped` containers can start without a separate app unit. Apply this only to the dedicated Verus VM. The Compose override uses `create_host_path: false`; it cannot silently create missing data directories on the root disk. Do not bypass the guard or run Docker manually when it fails.

Create `/srv/verus-data/private/workspace.env` once with root ownership and mode 0600. Set `DOMAIN=verus.preman.live`, `ACME_EMAIL` to the actual certificate contact, and `MINDTRUST_ADMIN_TOKEN` to a cryptographically random 64-character hex value generated on the VM. Generate and write the token within a program/file redirection so it never appears in terminal output or command arguments. Preserve an existing secret on resume. No provider credential is needed on this server for the local PreMan evaluation runner.

In a root shell with tracing disabled, use the same project name and both Compose files on every operation:

```sh
cd /opt/verus/current
verus_compose=(docker compose --project-name verus --env-file /srv/verus-data/private/workspace.env -f deploy/compose.production.yaml -f deploy/compose.lightsail.yaml)
"${verus_compose[@]}" config --quiet
"${verus_compose[@]}" up --build -d
"${verus_compose[@]}" ps
```

Never print plain `docker compose config` or full `docker inspect`: both can reveal environment secrets. The base stack remains unchanged; the override replaces only `/app/data`, Caddy `/data`, and Caddy `/config` with directories on the encrypted disk. It preserves the exact proxy IP trust, private application port, readiness dependency, and production authentication.

Add a Squarespace A record for host `verus` to the dedicated static IPv4 address. Preserve every existing record, especially the root and `api` records. Only add AAAA if IPv6 has also been explicitly configured and tested. Caddy obtains/renews TLS after DNS reaches this VM and ports 80/443 are reachable. Then run the [public acceptance checks and PreMan evaluation procedure](verus-hosting.md). Verify the app survives a controlled VM reboot with the same database before considering persistence tested.

## 5. Back up first, then take scheduled snapshots

Run and inspect the initial backup, then enable its daily timer:

```sh
sudo systemctl start verus-backup.service
sudo systemctl status verus-backup.service --no-pager
sudo systemctl enable --now verus-backup.timer
sudo systemctl list-timers verus-backup.timer --no-pager
```

The host makes a consistent online SQLite backup at **03:00 UTC**, verifies its manifest/checksum/integrity, and flushes the filesystem. A separate container uses the running release image, no network, no application secrets, a read-only source mount, and the encrypted disk's backup directory. `/srv/verus-data/backups/latest-verified` identifies the last completed backup. Source database contents are never copied directly while live.

After the first verified backup, enable instance automatic snapshots from CloudShell at **04:00 UTC**:

```sh
aws lightsail enable-add-on --region "$verus_region" --resource-name verus-prod --add-on-request '{"addOnType":"AutoSnapshot","autoSnapshotAddOnRequest":{"snapshotTimeOfDay":"04:00"}}'
aws lightsail get-auto-snapshots --region "$verus_region" --resource-name verus-prod
```

Instance snapshots [include the attached disk](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-block-storage.html). Thus one schedule protects the OS, release, encrypted workspace, Caddy state, and completed database backups; no AWS credentials or IAM role are required inside the VM. AWS [retains seven daily automatic snapshots](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-automatic-snapshots.html). Check the first actual snapshot completion rather than treating add-on enablement as backup evidence. Snapshot execution is independent of the host timer: a failed/delayed SQLite backup can leave a snapshot with an older verified backup.

No file pruning is automated. Check disk space, `latest-verified` age, and `journalctl -u verus-backup.service`; the backup refuses to start without space for its estimated size plus a 1 GiB reserve. Set operational alerting and review local retention before the 20 GiB disk fills. Delete only explicitly selected obsolete backup/manifest pairs after verifying usable snapshots. Automatic snapshots disappear when their source instance is deleted; preserve needed points as manual snapshots before removal. Snapshot storage is billed separately.

Restore a completed SQLite backup to a **new path** using the [backup/restore runbook](production-operations.md), verify it in an isolated process, and measure recovery before claiming a recovery objective. Never overwrite the active database to test recovery. Do not revert an upgraded database by merely switching to older application code.

These files can be syntax/Compose-validated locally without a Docker daemon. Disk mounting, the systemd startup gate, the backup container's access to live SQLite WAL data, reboot recovery, DNS/TLS, and AWS snapshots still require verification on the actual Linux deployment.
