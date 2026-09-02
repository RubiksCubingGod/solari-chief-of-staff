'use client';

import { useEffect, useRef, useState } from 'react';

import 'rrweb-player/dist/style.css';

import { RecordingFetchError, describeReplayFailure, parseRecording } from './recording-events';

/**
 * The replay: a recording fetched from this dashboard's own route and played
 * by rrweb-player, inside the page that describes the run.
 *
 * The one client component in the dashboard, because a player is a thing that
 * runs; everything else is rendered on the server from what the API said. The
 * recording is fetched here rather than inlined into the page for the reasons
 * it is proxied rather than linked: it can be large, it is private, and a page
 * that could not get it must still be a page - the trail beside this stays.
 */
interface ReplayPlayerProps {
  /** Same-origin path the recording is served from, as NDJSON. */
  readonly src: string;
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'playing' }
  | { readonly kind: 'failed'; readonly message: string };

/** What a mounted player needs to be taken down again. */
interface Mounted {
  $destroy(): void;
}

/**
 * rrweb-player is a Svelte 4 component and its typings extend Svelte's, which
 * the dashboard does not install: the compiled player carries its own runtime.
 * To the type checker the class is therefore only its own getters, so the
 * tear-down method is checked on the instance rather than assumed.
 */
function isMounted(player: object): player is Mounted {
  return '$destroy' in player && typeof player.$destroy === 'function';
}

export function ReplayPlayer({ src }: ReplayPlayerProps) {
  const target = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let mounted: Mounted | undefined;

    async function mount(): Promise<void> {
      const response = await fetch(src, {
        credentials: 'same-origin',
        headers: { accept: 'application/x-ndjson' },
      });
      if (!response.ok) throw new RecordingFetchError(response.status);
      const events = parseRecording(await response.text());
      // Loaded on demand: the player is the heaviest thing the dashboard ships
      // and most pages never need it.
      const { default: Player } = await import('rrweb-player');
      if (cancelled || target.current === null) return;
      const player = new Player({
        target: target.current,
        props: { events, autoPlay: true, showController: true, width: 960, height: 540 },
      });
      mounted = isMounted(player) ? player : undefined;
      setPhase({ kind: 'playing' });
    }

    mount().catch((error: unknown) => {
      if (!cancelled) setPhase({ kind: 'failed', message: describeReplayFailure(error) });
    });

    return () => {
      cancelled = true;
      mounted?.$destroy();
    };
  }, [src]);

  return (
    <div>
      {phase.kind === 'loading' ? <p>Loading the recording…</p> : null}
      {phase.kind === 'failed' ? <p role="alert">{phase.message}</p> : null}
      <div ref={target} />
    </div>
  );
}
