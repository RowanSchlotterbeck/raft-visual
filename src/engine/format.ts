import type { RaftEvent } from './events';

/**
 * A compact, human-readable one-line rendering of an event, e.g.
 *   t= 23 message_sent      #4 S2->S1 RequestVote(term=1, lastLog=0@0) due t=25
 * Handy for logs, debugging, and a plain-text event panel.
 */
export function formatEvent(e: RaftEvent): string {
  const t = `t=${String(e.time).padStart(3)}`;
  switch (e.type) {
    case 'message_sent':
    case 'message_delivered': {
      const m = e.message;
      const r = m.rpc;
      const body =
        r.type === 'RequestVote'
          ? `RequestVote(term=${r.term}, lastLog=${r.lastLogIndex}@${r.lastLogTerm})`
          : r.type === 'RequestVoteReply'
            ? `RequestVoteReply(term=${r.term}, granted=${r.voteGranted})`
            : r.type === 'AppendEntries'
              ? `AppendEntries(term=${r.term}, prev=${r.prevLogIndex}@${r.prevLogTerm}, entries=${r.entries.length}, commit=${r.leaderCommit})`
              : `AppendEntriesReply(term=${r.term}, success=${r.success}, match=${r.matchIndex})`;
      return `${t} ${e.type.padEnd(17)} #${m.id} S${m.from}->S${m.to} ${body}${e.type === 'message_sent' ? ` due t=${m.deliverAt}` : ''}`;
    }
    case 'message_dropped':
      return `${t} message_dropped   #${e.message.id} S${e.message.from}->S${e.message.to} (${e.reason})`;
    default: {
      const rest: Record<string, unknown> = { ...e };
      delete rest.seq;
      delete rest.time;
      delete rest.type;
      return `${t} ${e.type.padEnd(17)} ${JSON.stringify(rest)}`;
    }
  }
}
