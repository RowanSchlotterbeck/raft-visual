import { UI_CLUSTER_CONFIG } from '../sim/simulation';
import './LearnMore.css';

/** TODO: link to the companion C++ Raft implementation. Left empty on purpose until the URL is known. */
const CPP_REPO_URL = '';

const PAPER_URL = 'https://raft.github.io/raft.pdf';
const RAFT_SITE_URL = 'https://raft.github.io/';

/** Static background on what the simulation is, what it models, and where to read more. */
export function LearnMore() {
  return (
    <article className="learn">
      <header className="learn__intro">
        <p className="eyebrow">About this simulation</p>
        <h2>A real Raft cluster, small enough to watch</h2>
        <p>
          Raft, live runs an actual implementation of the Raft consensus algorithm in your browser. It isn’t a scripted
          animation: each server is a small state machine that follows the rules in Figure 2 of the Raft paper, and
          everything on screen is drawn from the servers’ real state and the events they report.
        </p>
        <p>
          It is also deterministic. Time moves in ticks, and nothing happens unless the clock advances. The only
          randomness (each server’s election timeout) comes from a seeded generator, so the same seed and the same
          actions replay the same run. The seed and cluster size are in the page URL, so you can share a run.
        </p>
      </header>

      <div className="learn__grid">
        <section className="learn__card">
          <h3>What it models</h3>
          <ul>
            <li>
              <b>Leader election</b> with randomized timeouts, one vote per server per term, and the rule that a
              candidate’s log must be at least as up to date as the voter’s.
            </li>
            <li>
              <b>Terms.</b> Any message from a newer term makes a server adopt that term and step down to follower.
            </li>
            <li>
              <b>Log replication.</b> AppendEntries carries entries and heartbeats. Followers check that their logs
              match, delete conflicting entries, and the leader walks back until the logs agree.
            </li>
            <li>
              <b>Commitment.</b> An entry commits once a majority stores it, but a leader only counts replicas for entries
              from its own term (the case shown in the paper’s Figure 8). A new leader adds a no-op entry so it can
              commit right away.
            </li>
            <li>
              <b>Applying</b> committed entries, in order, to a small key/value store on every server.
            </li>
            <li>
              <b>Crashes.</b> A crashed server keeps its term, vote and log, and loses everything else, including its
              store, which it rebuilds from the log after restarting.
            </li>
            <li>
              <b>Network partitions.</b> Messages that cross the split are dropped.
            </li>
          </ul>
        </section>

        <section className="learn__card">
          <h3>What it doesn’t model</h3>
          <ul>
            <li>
              <b>A real network or real time.</b> Messages are passed in memory and each takes {UI_CLUSTER_CONFIG.msgDelay} ticks. They are never
              lost at random, duplicated or reordered. Only partitions and crashes lose them.
            </li>
            <li>
              <b>Disk.</b> “Persistent” state survives a crash, but nothing is written to storage.
            </li>
            <li>
              <b>Extensions beyond Figure 2:</b> log compaction and snapshots, cluster membership changes, read-only
              queries, and client retries or duplicate detection.
            </li>
            <li>
              <b>PreVote and CheckQuorum.</b> Without them, a server that rejoins with a higher term forces a new
              election, and a leader cut off from the majority keeps believing it leads. Both are visible here.
            </li>
          </ul>
          <p className="learn__note">
            It’s a teaching model. The engine behind it is covered by an automated test suite that checks Raft’s five
            safety properties through random crashes and partitions.
          </p>
        </section>
      </div>

      <section className="learn__card">
        <h3>How to drive it</h3>
        <dl className="learn__how">
          <dt>Clock</dt>
          <dd>Play or pause (space), step one tick (→), and set the speed with the slider.</dd>
          <dt>Run</dt>
          <dd>Pick a seed and a cluster size from 1 to 7 servers, then Restart.</dd>
          <dt>Servers</dt>
          <dd>Each card has Kill / Revive and Time out, which makes its election timer fire on the next tick.</dd>
          <dt>Clients</dt>
          <dd>Send write sets x, y or z on the leader, or on a server you choose, to see what a non-leader does.</dd>
          <dt>Network</dt>
          <dd>Click server chips under Split network to cut them off onto side B; Heal reconnects everyone.</dd>
        </dl>
      </section>

      <section className="learn__card learn__refs">
        <h3>References</h3>
        <ul>
          <li>
            Diego Ongaro and John Ousterhout,{' '}
            <a href={PAPER_URL} target="_blank" rel="noopener noreferrer">
              In Search of an Understandable Consensus Algorithm (Extended Version)
            </a>
            . The paper this simulation follows.
          </li>
          <li>
            <a href={RAFT_SITE_URL} target="_blank" rel="noopener noreferrer">
              The Raft Consensus Algorithm
            </a>{' '}
            (raft.github.io): visualizations, talks and implementations.
          </li>
        </ul>
        <p className="learn__note">
          Built alongside a full Raft implementation in C++.{' '}
          {CPP_REPO_URL ? (
            <a href={CPP_REPO_URL} target="_blank" rel="noopener noreferrer">
              View the repository
            </a>
          ) : (
            <span className="learn__placeholder">(Repository link to be added.)</span>
          )}
        </p>
      </section>
    </article>
  );
}
