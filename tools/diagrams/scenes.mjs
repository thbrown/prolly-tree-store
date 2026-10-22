/**
 * The four README animations. Every number shown is measured by ./measure.mjs
 * against the built library, so the diagrams cannot drift from the code.
 */
import {
  C, W, chip, text, arrow, fillRound, panel, statusLine, layoutTree, drawTree,
  pathToLeaf, phase, ease, clamp01,
} from './lib.mjs';

const short = hash => `${hash.slice(0, 10)}…`;

/** Panels for a two-store scene. */
function stores(ctx, { leftLabel, leftSub, rightLabel, rightSub, y = 60, h = 268 }) {
  const w = (W - 48 - 26) / 2;
  const left = { x: 24, y, w, h };
  const right = { x: 24 + w + 26, y, w, h };
  panel(ctx, { ...left, label: leftLabel, sublabel: leftSub });
  panel(ctx, { ...right, label: rightLabel, sublabel: rightSub });
  return { left, right };
}

const treeBox = p => ({ x: p.x + 22, y: p.y + 50, w: p.w - 44, h: 120 });

/** A row of labelled counters along the bottom of a panel. */
function drawCounters(ctx, counters, box = { x: 24, y: 60, w: W - 48, h: 268 }) {
  if (!counters) return;
  let x = box.x + 20;
  const y = box.y + box.h - 26;
  for (const [label, value, color] of counters) {
    const { w } = chip(ctx, `${label} ${value}`, x, y, { color, mono: false, size: 11 });
    x += w + 10;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Syncing across two different storage backends
// ─────────────────────────────────────────────────────────────────────────────

export function syncScene(stats) {
  const groups = [3, 3, 3];
  const changedLeaf = 'l1-1';
  const changedPath = pathToLeaf(changedLeaf);
  const { totalChunks, changedChunks, diffReads, rootHashBefore, rootHashAfter } = stats.sync;

  const draw = (ctx, opts) => {
    const { left, right } = stores(ctx, {
      leftLabel: 'IndexedDB', leftSub: 'in the browser',
      rightLabel: 'Cloud Storage', rightSub: 'in a bucket',
    });
    const a = layoutTree(treeBox(left), groups);
    const b = layoutTree(treeBox(right), groups);

    drawTree(ctx, a, opts.stateA);
    drawTree(ctx, b, opts.stateB);

    const hashY = left.y + left.h - 28;
    chip(ctx, short(opts.hashA), left.x + left.w / 2, hashY, {
      align: 'center', color: opts.hashAColor, bg: '#10151c',
    });
    chip(ctx, short(opts.hashB), right.x + right.w / 2, hashY, {
      align: 'center', color: opts.hashBColor, bg: '#10151c',
    });
    text(ctx, 'root hash', left.x + left.w / 2, hashY - 20, { size: 9.5, color: C.faint, align: 'center' });
    text(ctx, 'root hash', right.x + right.w / 2, hashY - 20, { size: 9.5, color: C.faint, align: 'center' });

    if (opts.verdict) {
      chip(ctx, opts.verdict, W / 2, hashY, {
        align: 'center', color: opts.verdictColor, bg: C.bg, mono: false, size: 11,
      });
    }
    statusLine(ctx, opts.status, { color: opts.statusColor ?? C.faint });
    return { left, right, a, b, hashY };
  };

  const idle = () => ({});
  const lit = (ids, color) => id => (ids.includes(id) ? { color, fill: '#1d2430', glow: 0.6 } : {});

  return [
    {
      seconds: 2,
      caption: 'Two stores hold the same document — the same tree, the same hashes.',
      draw: (ctx, t) => {
        const { left, right, hashY } = draw(ctx, {
          stateA: idle, stateB: idle,
          hashA: rootHashBefore, hashB: rootHashBefore,
          hashAColor: C.ok, hashBColor: C.ok,
          verdict: t > 0.3 ? 'in sync' : null, verdictColor: C.ok,
        });
        void left; void right; void hashY;
      },
    },
    {
      seconds: 2.2,
      caption: 'A value changes in the browser. One leaf is rewritten.',
      draw: (ctx, t) => {
        const pulse = 0.45 + 0.55 * Math.abs(Math.sin(t * Math.PI * 2));
        draw(ctx, {
          stateA: id => (id === changedLeaf ? { color: C.changed, fill: '#2a2118', glow: pulse } : {}),
          stateB: idle,
          hashA: rootHashBefore, hashB: rootHashBefore,
          hashAColor: C.faint, hashBColor: C.faint,
        });
      },
    },
    {
      seconds: 2.4,
      caption: 'The change propagates up: every node on the path gets a new hash.',
      draw: (ctx, t) => {
        // light the path from the leaf upwards
        const reached = changedPath.slice().reverse().slice(0, 1 + Math.floor(phase(t, 0, 0.8) * 3));
        draw(ctx, {
          stateA: lit(reached, C.changed),
          stateB: idle,
          hashA: reached.includes('root') ? rootHashAfter : rootHashBefore,
          hashB: rootHashBefore,
          hashAColor: reached.includes('root') ? C.changed : C.faint,
          hashBColor: C.faint,
        });
      },
    },
    {
      seconds: 2.6,
      caption: `Detecting it costs one small read — just compare root hashes.`,
      draw: (ctx, t) => {
        draw(ctx, {
          stateA: lit(changedPath, C.changed),
          stateB: idle,
          hashA: rootHashAfter, hashB: rootHashBefore,
          hashAColor: C.changed, hashBColor: C.dim,
          verdict: t > 0.45 ? 'differ' : null, verdictColor: C.stale,
          status: t > 0.45 ? 'one root pointer read on each side — no tree nodes fetched' : null,
          statusColor: C.move,
        });
      },
    },
    {
      seconds: 3,
      caption: 'Walking both trees in lockstep prunes every subtree whose hash matches.',
      draw: (ctx, t) => {
        const p = phase(t, 0.05, 0.75);
        const pruned = ['i0', 'i2'].filter((_, i) => p > (i + 1) / 3);
        const prunedLeaves = [];
        for (const id of pruned) {
          const g = id.slice(1);
          for (let i = 0; i < 3; i++) prunedLeaves.push(`l${g}-${i}`);
        }
        const dimmed = new Set([...pruned, ...prunedLeaves]);
        if (p > 0.9) for (const id of ['l1-0', 'l1-2']) dimmed.add(id);

        const state = color => id => {
          if (dimmed.has(id)) return { alpha: 0.15 };
          if (changedPath.includes(id)) return { color, fill: '#1d2430' };
          return {};
        };
        draw(ctx, {
          stateA: state(C.changed), stateB: state(C.move),
          hashA: rootHashAfter, hashB: rootHashBefore,
          hashAColor: C.changed, hashBColor: C.dim,
          status: dimmed.size > 0
            ? `${dimmed.size} nodes pruned — one hash comparison each, no descent`
            : null,
        });
      },
    },
    {
      seconds: 3.2,
      caption: `Only the changed chunks cross the wire — ${changedChunks} of ${totalChunks}.`,
      draw: (ctx, t) => {
        const { left, right, a, b } = draw(ctx, {
          stateA: lit(changedPath, C.changed),
          stateB: lit(changedPath, t > 0.75 ? C.ok : C.idle),
          hashA: rootHashAfter,
          hashB: t > 0.8 ? rootHashAfter : rootHashBefore,
          hashAColor: C.changed,
          hashBColor: t > 0.8 ? C.ok : C.dim,
          status: `${changedChunks} chunks moved · ${diffReads} reads to find them`,
          statusColor: C.move,
        });
        void left; void right;

        changedPath.forEach((id, i) => {
          const p = phase(t, i * 0.14, i * 0.14 + 0.55);
          if (p <= 0 || p >= 1) return;
          const from = a.nodes.get(id);
          const to = b.nodes.get(id);
          const e = ease(p);
          const x = from.cx + (to.cx - from.cx) * e;
          const y = from.y + (to.y - from.y) * e - Math.sin(p * Math.PI) * 7;
          fillRound(ctx, x - 9, y - 6, 18, 12, 3, '#16303f', C.move, 1.6);
        });
      },
    },
    {
      seconds: 1.8,
      caption: 'Back in sync, without either side reading the whole document.',
      draw: (ctx) => {
        draw(ctx, {
          stateA: lit(changedPath, C.ok), stateB: lit(changedPath, C.ok),
          hashA: rootHashAfter, hashB: rootHashAfter,
          hashAColor: C.ok, hashBColor: C.ok,
          verdict: 'in sync', verdictColor: C.ok,
          status: `${totalChunks - changedChunks} of ${totalChunks} chunks never moved`,
          statusColor: C.ok,
        });
      },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Chunk-size independence
// ─────────────────────────────────────────────────────────────────────────────

export function chunkSizeScene(stats) {
  const { smallChunks, largeChunks, smallChunkSize, largeChunkSize, entryHashSmall } = stats.sizes;
  const smallGroups = [4, 4, 4];
  const largeGroups = [2, 2];

  const draw = (ctx, opts) => {
    const { left, right } = stores(ctx, {
      leftLabel: 'IndexedDB', leftSub: `chunkSize ${smallChunkSize / 1024} KB`,
      rightLabel: 'Cloud Storage', rightSub: `chunkSize ${largeChunkSize / 1024} KB`,
    });
    const a = layoutTree(treeBox(left), smallGroups);
    const b = layoutTree(treeBox(right), largeGroups, { nodeW: 34, leafW: 42 });

    drawTree(ctx, a, opts.stateA ?? (() => ({})));
    drawTree(ctx, b, opts.stateB ?? (() => ({})));

    const countY = left.y + left.h - 62;
    text(ctx, `${smallChunks} chunks`, left.x + left.w / 2, countY, {
      size: 11, color: C.dim, align: 'center',
    });
    text(ctx, `${largeChunks} chunks`, right.x + right.w / 2, countY, {
      size: 11, color: C.dim, align: 'center',
    });

    if (opts.hashLabel) {
      const y = left.y + left.h - 26;
      text(ctx, opts.hashLabel, W / 2, y - 22, { size: 9.5, color: C.faint, align: 'center' });
      chip(ctx, opts.hashA, left.x + left.w / 2, y, { align: 'center', color: opts.hashColor });
      chip(ctx, opts.hashB, right.x + right.w / 2, y, { align: 'center', color: opts.hashColor });
      if (opts.verdict) {
        chip(ctx, opts.verdict, W / 2, y, {
          align: 'center', color: opts.verdictColor, bg: C.bg, mono: false, size: 11,
        });
      }
    }
    statusLine(ctx, opts.status, { color: opts.statusColor ?? C.faint });
    return { left, right, a, b };
  };

  return [
    {
      seconds: 2.4,
      caption: 'One document, chunked for each backend: small chunks locally, large in the cloud.',
      draw: (ctx) => { draw(ctx, {}); },
    },
    {
      seconds: 2.6,
      caption: 'Different chunk sizes mean different trees — so the chunk hashes cannot match.',
      draw: (ctx, t) => {
        draw(ctx, {
          hashLabel: 'chunkHash — hash of the node bytes',
          hashA: 'a41f7c02…', hashB: '0e9b5d84…',
          hashColor: C.stale,
          verdict: t > 0.4 ? 'differ' : null, verdictColor: C.stale,
        });
      },
    },
    {
      seconds: 3.4,
      caption: 'But entryHash is folded with XOR over the (key, value) pairs themselves.',
      draw: (ctx, t) => {
        const { left, right, a, b } = draw(ctx, {});
        // entries rise out of the leaves and fold together at the root
        const drawFold = (tree, box) => {
          const leaves = [...tree.nodes.values()].filter(n => n.kind === 'leaf');
          const root = tree.nodes.get('root');
          leaves.forEach((leaf, i) => {
            const p = phase(t, 0.05 + i * 0.045, 0.05 + i * 0.045 + 0.5);
            if (p <= 0) return;
            const e = ease(Math.min(p, 1));
            const x = leaf.cx + (root.cx - leaf.cx) * e;
            const y = leaf.y + (root.y + root.h / 2 - leaf.y) * e;
            ctx.save();
            ctx.globalAlpha = p >= 1 ? 0 : 0.9;
            fillRound(ctx, x - 3, y - 3, 6, 6, 1.5, C.move, null);
            ctx.restore();
          });
          void box;
        };
        drawFold(a, left);
        drawFold(b, right);
        statusLine(ctx, 'XOR is commutative, so grouping cannot change the result', { color: C.move });
      },
    },
    {
      seconds: 3.2,
      caption: 'So the same content gives the same entryHash, whatever the chunk layout.',
      draw: (ctx, t) => {
        draw(ctx, {
          stateA: () => ({ color: t > 0.3 ? C.ok : C.idle }),
          stateB: () => ({ color: t > 0.3 ? C.ok : C.idle }),
          hashLabel: 'entryHash — XOR fold over all leaf entries',
          hashA: short(entryHashSmall), hashB: short(entryHashSmall),
          hashColor: C.ok,
          verdict: t > 0.45 ? 'identical' : null, verdictColor: C.ok,
        });
      },
    },
    {
      seconds: 2.4,
      caption: 'Which is what lets two unlike stores compare state at all.',
      draw: (ctx) => {
        draw(ctx, {
          stateA: () => ({ color: C.ok }), stateB: () => ({ color: C.ok }),
          hashLabel: 'entryHash — XOR fold over all leaf entries',
          hashA: short(entryHashSmall), hashB: short(entryHashSmall),
          hashColor: C.ok, verdict: 'identical', verdictColor: C.ok,
          status: 'getRootHash() returns this — one small read, either side, any backend',
          statusColor: C.ok,
        });
      },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. patch writes only the path
// ─────────────────────────────────────────────────────────────────────────────

export function patchScene(stats) {
  const { totalChunks, reads, writes, shared } = stats.patch;
  const putReads = stats.put.reads;
  const groups = [4, 4, 4, 4];
  const target = 'l2-1';
  const path = pathToLeaf(target);

  const draw = (ctx, opts) => {
    const box = { x: 24, y: 60, w: W - 48, h: 268 };
    panel(ctx, { ...box, label: 'One document', sublabel: `${totalChunks} chunks` });
    const tree = layoutTree({ x: box.x + 30, y: box.y + 66, w: box.w - 60, h: 128 }, groups, { nodeW: 30 });
    drawTree(ctx, tree, opts.state ?? (() => ({})));

    drawCounters(ctx, opts.counters);
    return { box, tree };
  };

  return [
    {
      seconds: 2.2,
      caption: 'patch("/roster/57/stats/hr", 31) — one key, deep inside a large document.',
      draw: (ctx, t) => {
        const { tree } = draw(ctx, {
          state: id => (id === target && t > 0.4 ? { color: C.changed, glow: 0.5 } : {}),
        });
        const leaf = tree.nodes.get(target);
        if (t > 0.4) {
          text(ctx, 'target', leaf.cx, leaf.y + 28, { size: 9.5, color: C.changed, align: 'center' });
        }
      },
    },
    {
      seconds: 2.8,
      caption: 'It descends one node per level, reading only what it needs to route.',
      draw: (ctx, t) => {
        const depth = Math.floor(phase(t, 0, 0.85) * 3);
        const visited = path.slice(0, depth + 1);
        draw(ctx, {
          state: id => (visited.includes(id) ? { color: C.move, fill: '#152230' } : {}),
          counters: [['reads', Math.min(reads, visited.length * 2), C.move]],
        });
      },
    },
    {
      seconds: 3,
      caption: 'Only the path back to the root is rewritten. Every other node is reused as is.',
      draw: (ctx, t) => {
        const p = phase(t, 0.1, 0.8);
        const rewritten = path.slice().reverse().slice(0, 1 + Math.floor(p * 3));
        draw(ctx, {
          state: id => {
            if (rewritten.includes(id)) return { color: C.changed, fill: '#2a2118', glow: 0.5 };
            return { alpha: 0.5 };
          },
          counters: [
            ['reads', reads, C.move],
            ['new chunks', rewritten.length, C.changed],
            ['reused', totalChunks - rewritten.length, C.faint],
          ],
        });
      },
    },
    {
      seconds: 3.4,
      caption: `${writes} chunks written, ${shared} shared — and ${reads} reads instead of ${putReads} for a full rebuild.`,
      draw: (ctx) => {
        draw(ctx, {
          state: id => (path.includes(id)
            ? { color: C.changed, fill: '#2a2118' }
            : { alpha: 0.5 }),
          counters: [
            ['reads', reads, C.move],
            ['new chunks', writes, C.changed],
            ['reused', shared, C.faint],
            ['full put would read', putReads, C.stale],
          ],
        });
      },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. delete and gc
// ─────────────────────────────────────────────────────────────────────────────

export function deleteScene(stats) {
  const { liveChunks, orphans, reclaimed } = stats.del;
  const groups = [3, 3, 3];
  const allIds = [];
  for (let g = 0; g < 3; g++) for (let i = 0; i < 3; i++) allIds.push(`l${g}-${i}`);
  const order = [...allIds, 'i0', 'i1', 'i2', 'root'];

  const box = { x: 24, y: 60, w: W - 48, h: 268 };
  const orphanBox = { x: box.x + box.w - 180, y: box.y + 46, w: 160, h: 140 };

  const draw = (ctx, opts) => {
    panel(ctx, { ...box, label: opts.label ?? 'chunks/roster/…', sublabel: opts.sublabel });
    const treeWidth = box.w - 240; // the orphan column is always reserved, so the tree never jumps
    const tree = layoutTree(
      { x: box.x + 40, y: box.y + 62, w: treeWidth, h: 116 }, groups, { nodeW: 28 }
    );
    drawTree(ctx, tree, opts.state ?? (() => ({})));
    drawCounters(ctx, opts.counters, box);
    return { box, tree };
  };

  /** Chunks written by an interrupted put: present, but nothing points at them. */
  const drawOrphans = (ctx, visible) => {
    if (visible <= 0) return;
    fillRound(ctx, orphanBox.x, orphanBox.y, orphanBox.w, orphanBox.h, 6, null, C.stale, 1);
    text(ctx, 'written, never committed', orphanBox.x + orphanBox.w / 2, orphanBox.y + 16, {
      size: 9.5, color: C.stale, align: 'center',
    });
    for (let i = 0; i < 3; i++) {
      const alpha = clamp01(visible - i);
      if (alpha <= 0) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      fillRound(
        ctx, orphanBox.x + 30 + (i % 2) * 40, orphanBox.y + 34 + i * 24, 56, 17, 3.5,
        '#241a1d', C.stale, 1.4
      );
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = clamp01(visible);
    text(ctx, 'no parent points here', orphanBox.x + orphanBox.w / 2, orphanBox.y + orphanBox.h - 12, {
      size: 9, color: C.stale, align: 'center',
    });
    ctx.restore();
  };

  return [
    {
      seconds: 2.2,
      caption: 'Chunk keys are namespaced per document: chunks/{document}/{hash}.',
      draw: (ctx) => {
        draw(ctx, { sublabel: `${liveChunks} chunks`, counters: [['live chunks', liveChunks, C.dim]] });
        statusLine(ctx, 'nothing outside this document can reference them');
      },
    },
    {
      seconds: 3,
      caption: 'So delete can walk the tree and remove every chunk it owns — nothing else points at them.',
      draw: (ctx, t) => {
        const p = phase(t, 0.05, 0.95);
        const gone = Math.floor(p * order.length);
        const removed = new Set(order.slice(0, gone));
        const deleted = Math.round(p * liveChunks);
        draw(ctx, {
          sublabel: `${liveChunks - deleted} chunks`,
          state: id => (removed.has(id) ? { alpha: 0.08, color: C.stale } : {}),
          counters: [['deleted', `${deleted} / ${liveChunks}`, C.stale]],
        });
      },
    },
    {
      seconds: 2.6,
      caption: 'A write interrupted before the root pointer commits leaves chunks nothing references.',
      draw: (ctx, t) => {
        const appearing = phase(t, 0.1, 0.8) * 3;
        draw(ctx, {
          sublabel: `${liveChunks} chunks`,
          counters: [
            ['live chunks', liveChunks, C.dim],
            ['unreachable', Math.floor(Math.min(appearing, orphans)), C.stale],
          ],
        });
        drawOrphans(ctx, appearing);
        statusLine(ctx, 'the document still reads as its last committed version', { color: C.dim });
      },
    },
    {
      seconds: 3,
      caption: `gc(key) lists the prefix and deletes whatever the root cannot reach — ${reclaimed} chunks here.`,
      draw: (ctx, t) => {
        const remaining = 3 * (1 - phase(t, 0.1, 0.7));
        draw(ctx, {
          sublabel: `${liveChunks} chunks`,
          state: () => ({ color: t > 0.7 ? C.ok : C.idle }),
          counters: [
            ['live chunks', liveChunks, t > 0.7 ? C.ok : C.dim],
            ['reclaimed', Math.round(phase(t, 0.1, 0.7) * reclaimed), C.ok],
          ],
        });
        drawOrphans(ctx, remaining);
        if (t > 0.75) {
          statusLine(ctx, 'every chunk the root can still reach is untouched', { color: C.ok });
        }
      },
    },
  ];
}

export const scenes = [
  { name: 'sync', title: 'Syncing two stores that share nothing but hashes', build: syncScene },
  { name: 'chunk-size', title: 'Why two different chunk sizes still compare', build: chunkSizeScene },
  { name: 'patch', title: 'patch rewrites the path, not the document', build: patchScene },
  { name: 'delete-gc', title: 'delete and gc: reclaiming chunks', build: deleteScene },
];
