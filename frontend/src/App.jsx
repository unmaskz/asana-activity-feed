import React, { useEffect, useState } from 'react';

export default function App() {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_BASE_URL}/api/events`)
      .then(r => r.json())
      .then(d => setEvents(d.data || []));
  }, []);

  return (
    <div style={{ padding: 20, fontFamily: 'sans-serif' }}>
      <h1>Asana Activity Log</h1>
      {events.map(ev => (
        <div key={ev.id} style={{ marginBottom: 10, padding: 10, border: '1px solid #ccc' }}>
          <b>{ev.actor_name}</b> did <i>{ev.action_type}</i> on task {ev.task_id || 'unknown'} at {ev.created_at}
        </div>
      ))}
    </div>
  );
}