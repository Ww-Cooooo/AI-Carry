import assert from 'node:assert/strict';
import {projectAccumulation} from './accumulation-projection.mjs';
import {buildAccumulationData} from '../src/app/accumulation-data.mjs';
import {overviewView,networkView,networkEdge,detailGroups,sourceCounts,relationDescription} from '../src/app/accumulation-network.mjs';

const item = (id, title=id) => ({id, title, summary:'Existing content'});
const snapshot = {memories:[item('memory.one')], sops:[item('sop.one')], capabilities:[], experiences:[],
  evolution:[item('learning.one')], skills:{items:[item('skill.one')], exports:[item('export.one')]}};
const sources = [
  {asset:{id:'memory.one',source_refs:['event.example','private://hidden','missing.asset']}},
  {asset:{id:'sop.one',related_asset_ids:['memory.one'],source_refs:['learning.one']},uses:[{task_event_id:'task.example',outcome:'failure'}]},
  {asset:{id:'learning.one',representative_event_ids:['event.example']}},
  {asset:{id:'export.one',kind:'skill-export',source_asset_id:'sop.one'}},
];
snapshot.accumulation = projectAccumulation(sources, snapshot);
const data=buildAccumulationData(snapshot);
assert.equal(data.nodes.length,7);
assert.deepEqual(new Set(data.edges.map(edge=>edge.kind)),new Set(['source','used','related','learned','produced']));
assert.equal(data.edges.find(edge=>edge.kind==='used').outcome,'failure');
assert(data.adjacent('asset:sop.one').length===4);
assert(!JSON.stringify(snapshot.accumulation).match(/example|private|hidden|missing/));
assert.deepEqual(projectAccumulation(sources,snapshot),snapshot.accumulation,'unchanged input should retain anonymous grouping');
assert.equal(buildAccumulationData({...snapshot,accumulation:undefined}).nodes.length,5,'old snapshots keep their content');
assert.equal(buildAccumulationData({}).nodes.length,0,'empty template must not gain demo records');
const broken=buildAccumulationData({...snapshot,accumulation:{records:[null,{id:'record:99',kind:'task'}],links:[null,{source:'asset:memory.one',target:'missing',kind:'used'},{source:'asset:memory.one',target:'asset:sop.one',kind:'toString'}]}});
assert.equal(broken.nodes.length,5,'bad links and orphan markers cannot remove good content');
assert.equal(broken.edges.length,0);assert.equal(broken.skipped,4);
const crowded=projectAccumulation([{asset:{id:'memory.one',source_refs:Array.from({length:300},(_,i)=>'event.test-'+i)}}],snapshot);
assert.equal(crowded.records.length,256);assert.equal(crowded.truncated,true);
assert.equal(buildAccumulationData({...snapshot,accumulation:crowded}).nodes.filter(n=>n.entry).length,5);
const overview=overviewView(data);
assert(overview.groups.some(g=>g.kind==='source'),'anonymous source records remain distinguishable from tasks');
assert(overview.items.every(n=>data.byId[n.id]===n),'overview cannot synthesize task names or content');
assert.deepEqual(new Set(overview.items.map(n=>n.id)),new Set(data.nodes.map(n=>n.id)),'overview must include every item, not a sample');
assert.deepEqual(overview.edges,data.edges,'overview layout must retain all recorded links, not invent category links');
for(const node of overview.items)assert.equal(overview.degree[node.id],data.adjacent(node.id).length,'visual emphasis follows recorded relationships');
assert.equal(overviewView(buildAccumulationData({})).items.length,0);
const usedEdge=data.edges.find(e=>e.kind==='used'),display=networkEdge(usedEdge);
assert.equal(display.source,usedEdge.target);assert.equal(display.target,usedEdge.source);
assert.equal(display.evidenceSource,usedEdge.source);assert.equal(display.outcome,'failure');
assert.equal(networkEdge(data.edges.find(e=>e.kind==='produced')).tone,'formed');
const many={...snapshot,accumulation:projectAccumulation([
  {asset:{id:'memory.one',source_refs:['event.shared']},uses:Array.from({length:23},(_,i)=>({task_event_id:'task.use-'+i,outcome:i?'success':'failure'}))},
  {asset:{id:'sop.one',source_refs:['event.shared']}},
],snapshot)};
const rich=buildAccumulationData(many),focus='asset:memory.one';
const complete=overviewView(rich);
assert.equal(complete.items.length,rich.nodes.length,'many task records must not be truncated from the overview');
for(const node of complete.items)assert(complete.positions[node.id]?.every(Number.isFinite),'every item needs a navigable canvas position');
const sections=detailGroups(rich,rich.byId[focus]);
assert.equal(sections[0].primary,true);assert.equal(sections[0].edges.length,23,'sidebar presents the selected item task records first');
assert(sections[0].edges.some(e=>e.outcome==='failure'),'failed task results remain visible');
assert.equal(new Set(sections.flatMap(g=>g.edges)).size,rich.adjacent(focus).length,'sidebar keeps other sources and relationships too');
const manyNames=buildAccumulationData({memories:Array.from({length:80},(_,i)=>item('memory.'+i,'记录 '+i))});
assert.equal(overviewView(manyNames).items.length,80,'entries must not disappear when one category grows');
for(const limit of [5,7]) {
  const seen=new Set(),pages=networkView(rich,focus,0,limit).pages;
  for(let p=0;p<pages;p++) {
    const view=networkView(rich,focus,p,limit),visible=new Set(view.items.map(n=>n.id));
    assert(view.items.length<=limit,'large records must remain readable rather than adding every neighbour at once');
    assert(view.edges.every(e=>rich.edges.includes(e)&&visible.has(e.source)&&visible.has(e.target)));
    view.items.filter(n=>n.id!==focus).forEach(n=>seen.add(n.id));
  }
  for(const e of rich.adjacent(focus))assert(seen.has(e.source===focus?e.target:e.source),'paging must retain every direct relationship');
}
const old=buildAccumulationData({...snapshot,accumulation:undefined});
assert(networkView(old,'asset:memory.one').noRelations,'missing history stays missing, not reconstructed by name');
assert.equal(networkView(rich,'missing').missingFocus,true,'a stale focus falls back to the overview');
const sourceId=rich.nodes.find(n=>n.kind==='source').id;
assert(networkView(rich,sourceId).taskFocus,'source hubs can be explored without pretending they have task titles');
assert.equal(sourceCounts(rich)[sourceId],2);
assert(!sourceCounts(rich)[focus],'an item with 23 uses is not a shared origin');
const provenance=buildAccumulationData({
  memories:Array.from({length:6},(_,i)=>item('m'+i)),
  accumulation:{records:[{id:'record:1',kind:'source'},{id:'record:2',kind:'source'},{id:'record:3',kind:'task'}],links:[
    {source:'record:1',target:'asset:m0',kind:'source'},
    {source:'record:1',target:'asset:m0',kind:'learned'},
    {source:'record:1',target:'asset:m1',kind:'source'},
    {source:'record:2',target:'asset:m0',kind:'source'},
    {source:'record:2',target:'asset:m2',kind:'learned'},
    ...Array.from({length:6},(_,i)=>({source:'record:3',target:'asset:m'+i,kind:'used'})),
  ]},
});
assert.deepEqual(sourceCounts(provenance),{'record:1':2,'record:2':2},'count distinct accumulations and preserve multiple shared origins');
assert.equal(overviewView(provenance).role['record:3'],'hub','many uses may still make a visual hub');
assert(!overviewView(provenance).sourceCounts['record:3'],'usage alone must never create a source badge');
assert.deepEqual(networkView(provenance,'asset:m0').sourceCounts,sourceCounts(provenance),'focused views keep real origin roles independently of the focus');
const sourceGroups=detailGroups(provenance,provenance.byId['record:1']);
assert(sourceGroups.find(g=>g.label==='以它为来源的积累').edges.every(e=>e.source==='record:1'));
assert.equal(detailGroups(provenance,provenance.byId['record:3'])[0].edges.length,6,'usage stays separate from origin evidence');
const itemGroups=detailGroups(provenance,provenance.byId['asset:m0']);
assert.equal(itemGroups[0].edges.length,1,'task records stay first');
assert.equal(new Set(itemGroups.find(g=>g.label==='从哪里来').edges.map(e=>e.source)).size,2,'do not choose a fictional single root');
assert.equal(itemGroups.flatMap(g=>g.edges).length,provenance.adjacent('asset:m0').length,'sidebar lists each evidence edge exactly once');
assert.equal(relationDescription(usedEdge,usedEdge.target),'这次结果未通过验证','a use is not rewritten as learning or success');
assert.deepEqual(sourceCounts(old),{},'missing origin history must stay missing');
console.log('Accumulation map: genuine relations, privacy, complete overview, shared origins vs usage, task-first sidebar, bounded relationship paging and old/empty snapshots passed.');
