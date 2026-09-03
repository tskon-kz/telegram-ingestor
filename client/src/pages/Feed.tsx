import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  exchangeToken,
  fetchMessages,
  fetchSources,
  fetchTopics,
  type Message,
  type Source,
  type Topic,
} from '../api';
import { MessageCard } from '../components/MessageCard';
import { ThemeToggle } from '../components/ThemeToggle';

const ALL = '__all__';

export function Feed() {
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [topic, setTopic] = useState<string>(ALL);
  const [channel, setChannel] = useState<string>(ALL);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');

  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  // Shared message filter; `to` is made inclusive of the whole selected day.
  const filterParams = useMemo(
    () => ({
      topic: topic === ALL ? undefined : topic,
      channel: channel === ALL ? undefined : channel,
      from: from ? `${from}T00:00:00` : undefined,
      to: to ? `${to}T23:59:59.999` : undefined,
    }),
    [topic, channel, from, to],
  );

  // Exchange the one-time link token for a session cookie, then load metadata.
  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const t = params.get('t');
        if (t) {
          await exchangeToken(t);
          params.delete('t');
          const q = params.toString();
          window.history.replaceState({}, '', window.location.pathname + (q ? `?${q}` : ''));
        }
        const [tp, sr] = await Promise.all([fetchTopics(), fetchSources()]);
        setTopics(tp);
        setSources(sr);
        setReady(true);
      } catch (err) {
        setAuthError(err instanceof ApiError && err.status === 401
          ? 'Your session has expired. Open the feed link from the bot again.'
          : (err as Error).message);
      }
    })();
  }, []);

  // Reload messages whenever any filter changes.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setLoading(true);
    setListError(null);
    setMessages([]);
    setCursor(null);
    fetchMessages(filterParams)
      .then((page) => {
        if (cancelled) return;
        setMessages(page.data);
        setCursor(page.next_cursor);
      })
      .catch((err) => !cancelled && setListError((err as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ready, filterParams]);

  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchMessages({ ...filterParams, cursor });
      setMessages((prev) => [...prev, ...page.data]);
      setCursor(page.next_cursor);
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (authError) {
    return (
      <div className="page">
        <div className="notice error">{authError}</div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="page">
        <div className="notice">Loading…</div>
      </div>
    );
  }

  // Channels shown in the filter: scoped to the selected category when possible.
  const channelOptions = sources;

  return (
    <div className="page">
      <header className="head">
        <h1>My feed</h1>
        <ThemeToggle />
      </header>

      <nav className="tabs">
        <button className={topic === ALL ? 'tab active' : 'tab'} onClick={() => setTopic(ALL)}>
          All
        </button>
        {topics.map((t) => (
          <button
            key={t.id}
            className={topic === t.id ? 'tab active' : 'tab'}
            onClick={() => setTopic(t.id)}
          >
            {t.name}
            {t.source_count != null && <span className="count"> {t.source_count}</span>}
          </button>
        ))}
      </nav>

      <div className="filter">
        <label>
          Channel:{' '}
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value={ALL}>All channels</option>
            {channelOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {sourceLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From: <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To: <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(from || to) && (
          <button
            className="clear-dates"
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            Clear dates
          </button>
        )}
      </div>

      {listError && <div className="notice error">{listError}</div>}

      {!listError && messages.length === 0 && !loading && (
        <div className="notice">No messages yet.</div>
      )}

      <div className="messages">
        {messages.map((m) => (
          <MessageCard key={m.id} message={m} source={sourceById.get(m.source_id)} />
        ))}
      </div>

      {loading && <div className="notice">Loading…</div>}
      {cursor && !loading && (
        <button className="more" onClick={loadMore}>
          Load more
        </button>
      )}
    </div>
  );
}

function sourceLabel(s: Source): string {
  return s.title ?? (s.username ? `@${s.username}` : s.external_id);
}
