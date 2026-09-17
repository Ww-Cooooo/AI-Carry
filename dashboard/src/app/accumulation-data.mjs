export const kinds = {
  memory: {label:'记忆', color:'#7393d4', tint:'#edf2fc'},
  sop: {label:'固定流程（SOP）', color:'#76a89a', tint:'#edf5f0'},
  capability: {label:'能力', color:'#c5a15c', tint:'#faf4e5'},
  experience: {label:'经验', color:'#b58fab', tint:'#f6edf4'},
  learning: {label:'学习建议', color:'#80a997', tint:'#eef5ee'},
  skill: {label:'Skill', color:'#8b98bd', tint:'#eff1f8'},
  task: {label:'任务记录', color:'#527cce', tint:'#edf2fc'},
  source: {label:'来源记录', color:'#9babc4', tint:'#f1f4f8'},
};
const areas = {memories:'memory', sops:'sop', capabilities:'capability', experiences:'experience', evolution:'learning'};
const rows = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const labels = {source:'来自', learned:'学到了', used:'用过', related:'相关', produced:'整理成'};

/** Display adapter only. No body reads, fuzzy links, asset writes or permissions. */
export function buildAccumulationData(snapshot = {}, localize = value => value) {
  const nodes = [], byId = Object.create(null); let skipped = 0;
  const add = (items, area, kind, prefix) => rows(items).forEach(entry => {
    if (!entry || !text(entry.id) || !text(entry.title)) return;
    const id = `${prefix}:${entry.id}`;
    if (byId[id]) return;
    const node = {id, kind, area, assetId:entry.id, title:entry.title, summary:text(entry.summary), entry};
    byId[id] = node; nodes.push(node);
  });
  for (const [area, kind] of Object.entries(areas)) add(snapshot[area], area, kind, kind === 'learning' ? 'learning' : 'asset');
  add(snapshot.skills?.items, 'skills', 'skill', 'skill');
  add(snapshot.skills?.exports, 'exports', 'skill', 'export');
  const accumulation = snapshot.accumulation;
  if (accumulation != null && (typeof accumulation !== 'object' || !Array.isArray(accumulation.records) || !Array.isArray(accumulation.links))) skipped++;
  for (const record of rows(accumulation?.records).slice(0, 256)) {
    if (!record || !/^record:\d+$/.test(record.id) || !['task','source'].includes(record.kind) || byId[record.id]) { skipped++; continue; }
    const number = record.id.split(':')[1], task = record.kind === 'task';
    const node = {id:record.id, kind:record.kind, title:`${localize(task?'任务记录':'来源记录')} ${number}`,
      summary:localize(task?'这条结果记录说明任务曾使用所连的积累；地图用编号代替任务名称，不展开原始对话。':'相连内容引用了这条来源记录；地图用编号代替原始来源，不展开私密资料。')};
    byId[node.id] = node; nodes.push(node);
  }
  const edges = [], seen = new Set();
  for (const edge of rows(accumulation?.links).slice(0, 1024)) {
    if (!edge || !byId[edge.source] || !byId[edge.target] || edge.source === edge.target || !Object.hasOwn(labels, edge.kind)) { skipped++; continue; }
    const key = `${edge.source}|${edge.target}|${edge.kind}`;
    if (seen.has(key)) continue; seen.add(key);
    edges.push({id:`link:${edges.length+1}`, source:edge.source, target:edge.target, kind:edge.kind,
      label:localize(labels[edge.kind]), outcome:['success','failure'].includes(edge.outcome)?edge.outcome:undefined});
  }
  // Keep individual content, but omit record markers left without any valid link.
  const adjacency = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) { adjacency.get(edge.source).push(edge); adjacency.get(edge.target).push(edge); }
  const visible = nodes.filter(node => node.entry || adjacency.get(node.id).length);
  // Place connected components near each other, without squeezing the graph
  // into the viewport. The established force scene owns the final positions.
  const placed = new Set(); let group = 0;
  for (const first of [...visible].sort((a,b) => adjacency.get(b.id).length - adjacency.get(a.id).length)) {
    if (placed.has(first.id)) continue;
    const queue = [first.id]; placed.add(first.id); let index = 0;
    while (queue.length) {
      const id = queue.shift(), node = byId[id], angle = index * 2.39996, radius = Math.sqrt(index) * 95;
      const groupAngle=group*2.39996, groupRadius=Math.sqrt(group)*420;
      node.x = Math.cos(groupAngle)*groupRadius + Math.cos(angle)*radius;
      node.y = Math.sin(groupAngle)*groupRadius + Math.sin(angle)*radius; index++;
      for (const edge of adjacency.get(id)) {
        const other = edge.source === id ? edge.target : edge.source;
        if (!placed.has(other)) { placed.add(other); queue.push(other); }
      }
    }
    group++;
  }
  return {nodes:visible, edges, byId, skipped, partial:accumulation?.truncated===true,
    adjacent:id=>adjacency.get(id) ?? [],
    neighbourIds:id=>new Set([id,...(adjacency.get(id)??[]).flatMap(edge=>[edge.source,edge.target])]),
  };
}
