// Read-only views over recorded relationships. Display direction never changes
// the underlying evidence (a task's `used` edge still points to its asset).
export const collectionOrder = ['memory','sop','capability','experience','skill','learning','task','source'];
export const collectionDescriptions = {
  memory:'记住的偏好与约定', sop:'下次还能用的方法', capability:'可以调用的本领',
  experience:'实践中留下的体会', skill:'可以复用的方法包', learning:'待继续探索的想法',
  task:'积累被用过的记录', source:'积累引用的来源',
};
const formed = new Set(['learned','produced','source']);
const unique = items => [...new Set(items)];
export const otherEnd = (edge, id) => edge.source === id ? edge.target : edge.source;

// A shared source is supported by outgoing origin evidence, not its degree or
// screen position. Count each accumulation once; usage records are not origins.
export function sourceCounts(data) {
  const targets = new Map();
  for (const edge of data.edges) {
    if (!formed.has(edge.kind) || !data.byId[edge.source] ||
      !data.byId[edge.target] || ['task','source'].includes(data.byId[edge.target].kind)) continue;
    if (!targets.has(edge.source)) targets.set(edge.source,new Set());
    targets.get(edge.source).add(edge.target);
  }
  return Object.fromEntries([...targets].map(([id,items]) => [id,items.size]));
}

export function collectionGroups(data) {
  return collectionOrder.map(kind => ({kind, items:data.nodes.filter(n => n.kind === kind)
    .sort((a,b) => data.adjacent(b.id).length - data.adjacent(a.id).length || a.id.localeCompare(b.id))}))
    .filter(group => group.items.length);
}

export function overviewView(data) {
  const groups = collectionGroups(data);
  // Include every record. Types supply colour and navigation, never rows or
  // invented clusters. G6's force layout uses the real links to find positions.
  const items = data.nodes, positions = {}, degree = {}, role = {};
  items.forEach((node,i) => {
    const angle=i*2.39996323,radius=Math.sqrt(i)*65;
    positions[node.id]=[Number.isFinite(node.x)?node.x:Math.cos(angle)*radius,
      Number.isFinite(node.y)?node.y:Math.sin(angle)*radius];
    degree[node.id]=data.adjacent(node.id).length;
    if(degree[node.id]>4)role[node.id]='hub';
  });
  return {overview:true, items, groups, heads:[], positions, degree, role, sourceCounts:sourceCounts(data), badges:{}, hidden:{}, focus:null,
    edges:data.edges, pages:1, page:0, noRelations:items.length>0&&!data.edges.length};
}

export function detailGroups(data, node) {
  const edges=data.adjacent(node.id), tasks=edges.filter(e=>data.byId[otherEnd(e,node.id)]?.kind==='task');
  const used=edges.filter(e=>e.kind==='used');
  const primary=node.kind==='task'?used:tasks, included=new Set(primary);
  const origins=edges.filter(e=>!included.has(e)&&e.target===node.id&&formed.has(e.kind));
  origins.forEach(e=>included.add(e));
  const outputs=edges.filter(e=>!included.has(e)&&e.source===node.id&&formed.has(e.kind));
  outputs.forEach(e=>included.add(e));
  return [{label:node.kind==='task'?'这次用过的积累':'相关任务记录',edges:primary,primary:!['task','source'].includes(node.kind)},
    {label:'从哪里来',edges:origins},
    {label:'以它为来源的积累',edges:outputs},
    {label:'其他已记录的联系',edges:edges.filter(e=>!included.has(e))}];
}

export function relationDescription(edge, id) {
  if (edge.kind==='used') return edge.outcome==='failure'?'这次结果未通过验证':edge.outcome==='success'?'这次结果通过验证':'已有使用记录，结果未说明';
  if (edge.kind==='learned') return edge.target===id?'从这里学到':'从这项内容学到';
  if (edge.kind==='produced') return edge.target===id?'整理这份 Skill 时采用的来源':'由这项内容整理成';
  if (edge.kind==='source') return edge.target===id?'这项内容引用的来源':'引用了这项内容';
  return '已记录的相关内容';
}

export function networkEdge(edge) {
  return {...edge, evidenceSource:edge.source, evidenceTarget:edge.target,
    tone:edge.kind === 'used' ? 'used' : formed.has(edge.kind) ? 'formed' : 'related',
    source:edge.kind === 'used' ? edge.target : edge.source,
    target:edge.kind === 'used' ? edge.source : edge.target,
    label:edge.kind === 'used' ? '用在这件事' : edge.label};
}

function badge(edges, focus) {
  const has = kind => edges.some(edge => edge.kind === kind);
  if (has('used') && edges.some(edge => formed.has(edge.kind))) return '来源与使用';
  if (has('learned')) return edges.some(e => e.kind === 'learned' && e.source === focus.id) ? '从这里学到' : '学习来源';
  if (has('produced')) return edges.some(e => e.kind === 'produced' && e.source === focus.id) ? '由它整理成' : '整理来源';
  if (has('source')) return edges.some(e => e.kind === 'source' && e.source === focus.id) ? '引用了这项内容' : '内容来源';
  if (has('used')) return focus.kind === 'task' ? '这次用上' : '用在这件事';
  return '已有联系';
}

export function networkView(data, id, page = 0, limit = 7) {
  const focus = data.byId[id];
  if (!focus) return {...overviewView(data), missingFocus:true};
  const direct = data.adjacent(id), neighbours = unique(direct.map(e => otherEnd(e,id))).filter(key => data.byId[key]);
  const rank = key => { const edges = direct.filter(e => otherEnd(e,id) === key);
    return edges.some(e => formed.has(e.kind)) ? 0 : edges.some(e => e.kind === 'used') ? 1 : 2; };
  neighbours.sort((a,b) => rank(a)-rank(b));
  const taskFocus = focus.kind === 'task' || focus.kind === 'source';
  const budget = Math.max(3,Math.min(7,limit)), pageSize = taskFocus ? budget-1 : budget < 7 ? 2 : 3;
  const pages = Math.max(1,Math.ceil(neighbours.length/pageSize));
  const currentPage = Math.max(0,Math.min(pages-1,Math.floor(page) || 0));
  const shown = neighbours.slice(currentPage*pageSize,(currentPage+1)*pageSize);
  const ids = [id,...shown], role = {[id]:'focus'}, positions = {[id]:[.5,.47]}, badges = {}, hidden = {};
  const recordIds = shown.filter(key => ['task','source'].includes(data.byId[key].kind));
  const anchors = taskFocus ? [[.18,.23],[.79,.24],[.82,.69],[.20,.73],[.49,.08],[.51,.87]]
    : shown.length === 1 ? [[.22,.40]] : shown.length === 2 ? [[.23,.26],[.77,.64]] : [[.21,.25],[.80,.36],[.51,.83]];
  shown.forEach((key,i) => { role[key] = recordIds.includes(key) ? 'record' : 'direct'; positions[key] = anchors[i];
    badges[key] = badge(direct.filter(e => otherEnd(e,id) === key),focus); });
  const used = new Set(ids), contextLimit = Math.min(2,Math.floor((budget-ids.length)/Math.max(1,recordIds.length)));
  recordIds.forEach(record => {
    const index = shown.indexOf(record), available = data.adjacent(record).filter(e => !used.has(otherEnd(e,record)));
    const candidates = unique([
      ...available.filter(e => formed.has(e.kind)).slice(0,1).map(e => otherEnd(e,record)),
      ...available.filter(e => e.kind === 'used').slice(0,1).map(e => otherEnd(e,record)),
      ...available.map(e => otherEnd(e,record)),
    ]).filter(key => data.byId[key]).slice(0,contextLimit);
    const slots = shown.length === 1 ? [[.12,.10],[.13,.78]] : shown.length === 2
      ? index === 0 ? [[.11,.04],[.12,.71]] : [[.90,.32],[.73,.94]]
      : index === 0 ? [[.09,.06],[.10,.62]] : index === 1 ? [[.89,.09],[.91,.68]] : [[.28,.93],[.74,.94]];
    candidates.forEach((key,i) => {used.add(key);ids.push(key);role[key]='satellite';positions[key]=slots[i];});
  });
  const visible = new Set(ids), edges = data.edges.filter(e => visible.has(e.source) && visible.has(e.target));
  recordIds.forEach(key => hidden[key] = unique(data.adjacent(key).map(e => otherEnd(e,key))).filter(n => !visible.has(n)).length);
  return {overview:false, focus:id, items:ids.map(key => data.byId[key]), edges, role, positions, badges, hidden, heads:[], sourceCounts:sourceCounts(data),
    page:currentPage, pages, range:shown.length ? [currentPage*pageSize+1,currentPage*pageSize+shown.length] : [0,0],
    neighbourCount:neighbours.length, total:direct.length, taskFocus, noRelations:!direct.length};
}
