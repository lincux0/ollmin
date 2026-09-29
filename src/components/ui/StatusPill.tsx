interface StatusPillProps {
  online: boolean;
  label: string;
}

/** 供 Ollmin 与后续 Ollwork 壳复用的连接状态基件。 */
export default function StatusPill({ online, label }: StatusPillProps) {
  return (
    <div className={`status-pill ${online ? "online" : "offline"}`} role="status" aria-live="polite">
      <span className="status-dot" />
      {label}
    </div>
  );
}
