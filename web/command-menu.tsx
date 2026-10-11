import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Folder, Search, CornerDownLeft, type LucideIcon } from 'lucide-react';
import type { Project } from '../shared/types';
import { Modal } from './ui';

interface Command {
  id: string;
  label: string;
  detail: string;
  icon: LucideIcon;
  run: () => void;
}
export function CommandMenu({
  pages,
  projects,
  navigate,
  selectProject,
  onClose,
}: {
  pages: { id: string; label: string; icon: LucideIcon }[];
  projects: Project[];
  navigate: (id: string) => void;
  selectProject: (id: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const commands: Command[] = [
    ...pages.map((p) => ({ ...p, detail: 'Go to page', run: () => navigate(p.id) })),
    ...projects.map((p) => ({
      id: `project-${p.id}`,
      label: p.name,
      detail: 'Switch project',
      icon: Folder,
      run: () => selectProject(p.id),
    })),
  ].filter((c) => `${c.label} ${c.detail}`.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const choose = (c: Command) => {
    c.run();
    onClose();
  };
  return (
    <Modal title="Jump to…" onClose={onClose}>
      <div className="command-menu">
        <label className="command-search">
          <Search size={20} />
          <input
            autoFocus
            role="combobox"
            aria-label="Search pages and projects"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={commands[active] ? `command-${commands[active].id}` : undefined}
            value={search}
            placeholder="Search pages and projects…"
            onChange={(e) => {
              setSearch(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) =>
                  commands.length
                    ? (i + (e.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length
                    : 0,
                );
              }
              if (e.key === 'Enter' && commands[active]) {
                e.preventDefault();
                choose(commands[active]);
              }
            }}
          />
        </label>
        <div
          id="command-results"
          ref={list}
          className="command-results"
          role="listbox"
          aria-label="Pages and projects"
        >
          {commands.map((c, i) => (
            <button
              key={c.id}
              id={`command-${c.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'selected' : ''}
              onClick={() => choose(c)}
              onMouseMove={() => setActive(i)}
            >
              <c.icon size={17} />
              <span>
                {c.label}
                <small>{c.detail}</small>
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
          {!commands.length && <p className="muted">No matching pages or projects.</p>}
        </div>
        <div className="command-help">
          <span>↑ ↓ to navigate</span>
          <span>
            <CornerDownLeft size={12} /> to open
          </span>
          <span>esc to close</span>
        </div>
      </div>
    </Modal>
  );
}
