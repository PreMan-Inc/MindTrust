import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import {
  X,
  AlertCircle,
  ArrowUpRight,
  Inbox,
  LoaderCircle,
  ChevronRight,
  Copy,
  Check,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { stringify, copy } from './lib';
import { usePermissions } from './session';
let openModalCount = 0;
let originalBodyOverflow = '';
export function Button({
  children,
  variant = 'secondary',
  className = '',
  permission,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  permission?: 'write' | 'admin' | 'account';
}) {
  const access = usePermissions();
  const denied =
    permission === 'account'
      ? false
      : permission === 'admin'
        ? !access.canAdmin
        : permission === 'write' || props.type === 'submit'
          ? !access.canWrite
          : false;
  return (
    <button
      {...props}
      disabled={props.disabled || denied}
      title={
        props.title || (denied ? 'Your workspace role does not permit this action.' : undefined)
      }
      className={`button ${variant} ${className}`}
    >
      {children}
    </button>
  );
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Status({ value }: { value: string }) {
  return (
    <Badge
      tone={
        ['ok', 'completed', 'correct'].includes(value)
          ? 'green'
          : ['error', 'failed', 'incorrect'].includes(value)
            ? 'red'
            : ['running', 'queued', 'needs_review'].includes(value)
              ? 'amber'
              : 'neutral'
      }
    >
      <span className="status-dot" />
      {value.replaceAll('_', ' ')}
    </Badge>
  );
}
export function ErrorBox({ message }: { message?: string }) {
  return message ? (
    <div className="error-box" role="alert">
      <AlertCircle size={16} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={20} />
      Loading workspace data…
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={24} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}
export function Section({
  title,
  detail,
  children,
  actions,
  className = '',
}: {
  title: string;
  detail?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {detail && <p>{detail}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
  drawer = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    if (openModalCount === 0) originalBodyOverflow = document.body.style.overflow;
    openModalCount += 1;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      openModalCount -= 1;
      if (openModalCount === 0) document.body.style.overflow = originalBodyOverflow;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'wide' : ''} ${drawer ? 'drawer' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-inner">
        <div className="dialog-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </dialog>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Form({
  children,
  onSubmit,
  permission = 'write',
}: {
  children: ReactNode;
  onSubmit: () => void;
  permission?: 'write' | 'account';
}) {
  const access = usePermissions();
  const canWrite = permission === 'account' || access.canWrite;
  return (
    <form
      className="form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (canWrite) onSubmit();
      }}
    >
      {!canWrite && (
        <div className="permission-banner">
          <AlertCircle size={14} />
          Viewer access allows inspection. An editor or administrator can make changes.
        </div>
      )}
      <fieldset className="form-fields" disabled={!canWrite}>
        {children}
      </fieldset>
    </form>
  );
}
export function FormActions({
  busy,
  label = 'Save',
  onCancel,
}: {
  busy: boolean;
  label?: string;
  onCancel?: () => void;
}) {
  return (
    <div className="form-actions">
      {onCancel && (
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      )}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy && <LoaderCircle size={15} className="spin" />}
        {busy ? 'Working…' : label}
      </Button>
    </div>
  );
}
export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const text = value === undefined ? 'Not recorded' : (stringify(value) ?? 'null');
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="json-block">
      <div className="json-toolbar">
        <span className="json-label">{label || 'JSON'}</span>
        <div>
          <button
            type="button"
            className="icon-button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label || 'JSON'}`}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Copy ${label || 'JSON'}`}
            disabled={value === undefined}
            onClick={async () => {
              try {
                await copy(text);
                setCopied(true);
                setError('');
              } catch {
                setError('Unable to copy. Select the text to copy it manually.');
              }
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </div>
      <pre className={expanded ? '' : 'json-preview'}>{text}</pre>
      {error && (
        <div className="json-copy-error" role="status">
          {error}
        </div>
      )}
    </div>
  );
}
export function Stat({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        {icon}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-detail">{detail}</div>
    </div>
  );
}
export function Back({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button className="back-link" onClick={onClick}>
      <ChevronRight size={14} className="rotate" />
      {children}
    </button>
  );
}
export function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-link">
      {children}
      <ArrowUpRight size={13} />
    </a>
  );
}
