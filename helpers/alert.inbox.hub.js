/*
  Live push for the website bell (Server-Sent Events).

  Each open browser tab holds one GET /alerts/inbox/stream; this keeps those
  responses per user and writes to them when a notification lands. It lives
  in this process only — with several API processes a user may be connected
  to another one, which is why the bell also re-checks its count every
  minute. Nothing is lost either way: the notification is in the database.
*/
const clients = new Map(); // userId -> Set<res>
const HEARTBEAT_MS = 25 * 1000;

export const addInboxClient = (userId, res) => {
  const key = String(userId);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);
  // Comment lines keep proxies and the browser from closing an idle stream.
  const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  return () => {
    clearInterval(beat);
    clients.get(key)?.delete(res);
    if (!clients.get(key)?.size) clients.delete(key);
  };
};

export const pushToUser = (userId, event, data) => {
  const set = clients.get(String(userId));
  if (!set) return 0;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  set.forEach((res) => {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  });
  return set.size;
};
