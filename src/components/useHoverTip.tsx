import { useState, type ReactNode, type MouseEvent } from 'react';

/**
 * Instant custom tooltip for non-Recharts bars. The host element must have
 * className "tip-host" (position: relative); `bind(content)` spreads onto
 * each hoverable segment.
 */
export function useHoverTip() {
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean; content: ReactNode } | null>(null);

  const bind = (content: ReactNode) => ({
    onMouseMove: (e: MouseEvent<HTMLElement>) => {
      const host = (e.currentTarget as HTMLElement).closest('.tip-host');
      if (!host) return;
      const r = host.getBoundingClientRect();
      const x = Math.max(90, Math.min(e.clientX - r.left, r.width - 90));
      const y = e.clientY - r.top;
      setTip({ x, y, below: y < 64, content });
    },
    onMouseLeave: () => setTip(null),
  });

  const tipEl = tip ? (
    <div
      className={`chart-tip float-tip${tip.below ? ' below' : ''}`}
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.content}
    </div>
  ) : null;

  return { bind, tipEl };
}
