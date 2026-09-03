import type { Message, Source } from '../api';

export function MessageCard({ message, source }: { message: Message; source?: Source }) {
  const handle = source?.username ? `@${source.username}` : null;
  const title = source?.title ?? null;
  return (
    <article className="card">
      <div className="card-head">
        <span className="channel">
          {handle && (
            <a
              className="handle"
              href={`https://t.me/${source!.username}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {handle}
            </a>
          )}
          {title && <span className="title">{title}</span>}
          {!handle && !title && <span className="title">{source?.external_id ?? 'Unknown channel'}</span>}
        </span>
        <time>{formatDate(message.published_at)}</time>
      </div>
      {message.text && <p className="text">{message.text}</p>}
      {message.links.length > 0 && (
        <ul className="links">
          {message.links.map((href) => (
            <li key={href}>
              <a href={href} target="_blank" rel="noreferrer noopener">
                {href}
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
