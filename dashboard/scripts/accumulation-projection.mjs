// Only called during snapshot projection with already-read, validated sources.
// This is a view, never a new asset registry or a task execution permission.
export function projectAccumulation(sources, snapshot) {
  const keys = new Map();
  const add = (rows, prefix) => { for (const item of rows ?? []) {
    const list = keys.get(item.id) ?? []; list.push(`${prefix}:${item.id}`); keys.set(item.id, list);
  } };
  for (const area of ['memories', 'sops', 'capabilities', 'experiences']) add(snapshot[area], 'asset');
  add(snapshot.evolution, 'learning'); add(snapshot.skills?.items, 'skill'); add(snapshot.skills?.exports, 'export');
  const resolve = id => keys.get(id)?.length === 1 ? keys.get(id)[0] : null;
  const records = new Map(), links = new Map(); let truncated = false;
  const link = (source, target, kind, outcome) => {
    if (!source || !target || source === target) return;
    if (kind === 'related' && source > target) [source, target] = [target, source];
    const key = `${source}|${target}|${kind}`;
    if (!links.has(key) && links.size >= 1024) { truncated = true; return; }
    links.set(key, {source, target, kind, ...(outcome ? {outcome} : {})});
  };
  const record = (ref, kind) => {
    // Event names can contain personal context. They are grouping keys only:
    // expose neither raw IDs, private paths, host names, nor conversation text.
    if (typeof ref !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,159}$/.test(ref)) return null;
    if (!records.has(ref)) {
      if (records.size >= 256) { truncated = true; return null; }
      records.set(ref, {id: `record:${records.size + 1}`, kind});
    }
    const item = records.get(ref); if (kind === 'task') item.kind = kind;
    return item.id;
  };
  for (const {asset, uses = []} of sources) {
    const target = resolve(asset.id); if (!target) continue;
    for (const id of asset.related_asset_ids ?? []) link(resolve(id), target, 'related');
    for (const ref of asset.source_refs ?? []) {
      const source = resolve(ref);
      if (source) link(source, target, source.startsWith('learning:') ? 'learned' : 'source');
      else if (/^(event|task)[.:-]/.test(ref)) link(record(ref, 'source'), target, 'source');
    }
    for (const ref of asset.representative_event_ids ?? []) link(record(ref, 'source'), target, 'source');
    for (const use of uses) link(record(use.task_event_id, 'task'), target, 'used', use.outcome);
    if (asset.kind === 'skill-export') link(resolve(asset.source_asset_id), target, 'produced');
  }
  const used = new Set([...links.values()].flatMap(link => [link.source, link.target]));
  return {records: [...records.values()].filter(record => used.has(record.id)), links: [...links.values()], ...(truncated ? {truncated: true} : {})};
}
