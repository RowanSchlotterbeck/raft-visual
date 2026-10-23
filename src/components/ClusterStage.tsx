import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCluster } from '../sim/hooks';
import { stageLayout } from '../sim/layout';
import { LinkLayer } from './LinkLayer';
import { MessageLayer } from './MessageLayer';
import { NodeCard } from './NodeCard';
import './ClusterStage.css';

/**
 * The cluster drawn on a fixed-size stage (cards around an ellipse), scaled
 * down to fit the available width. Three layers share one coordinate system:
 * links under the cards, the cards, and messages over the cards.
 */
export function ClusterStage() {
  const { view, sim, highlighted } = useCluster();
  const { snapshot, sideB, effects } = view;
  const layout = useMemo(() => stageLayout(snapshot.nodes.length), [snapshot.nodes.length]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(layout.width);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(1, available / layout.width);

  // The newest became_leader effect per node drives that card's one-shot burst.
  const leaderFlash = new Map<number, number>();
  for (const fx of effects) if (fx.kind === 'leader') leaderFlash.set(fx.node, fx.seq);

  return (
    <div className="stage-wrap" ref={wrapRef} style={{ height: layout.height * scale }}>
      <div
        className="stage"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translateX(${Math.max(0, (available - layout.width * scale) / 2)}px) scale(${scale})`,
        }}
      >
        <LinkLayer layout={layout} sideB={sideB} />
        {snapshot.nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            center={layout.centers[node.id - 1]}
            majority={snapshot.majority}
            heartbeatInterval={snapshot.config.heartbeatInterval}
            side={sideB.length === 0 ? null : sideB.includes(node.id) ? 'B' : 'A'}
            highlighted={highlighted.includes(node.id)}
            leaderFlash={leaderFlash.get(node.id) ?? null}
            onKill={(id) => sim.kill(id)}
            onRevive={(id) => sim.revive(id)}
            onForceTimeout={(id) => sim.forceTimeout(id)}
          />
        ))}
        <MessageLayer layout={layout} sideB={sideB} inFlight={snapshot.inFlight} effects={effects} />
      </div>
    </div>
  );
}
