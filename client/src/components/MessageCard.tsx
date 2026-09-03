import type { Message, Source } from '../api';

export function MessageCard({ message, source }: { message: Message; source?: Source }) {
  const name = source
    ? source.title ?? (source.username ? `@${source.username}` : source.external_id)
    : 'Unknown channel';
  return (
    <article className="card">
      <div className="card-head">
        <span className="channel">{name}</span>
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
