import assert from 'node:assert/strict';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {executeFirstInstantiation} from './first-instantiation-transaction.mjs';
import {queryFormalAssetShortlist,loadTrustedDomainEnvelope,inspectAssetRoute,inspectAssetForReview} from './asset-route-contract.mjs';
import {buildSnapshotCandidate} from './snapshot-source-builder.mjs';
import {buildAccumulationData} from '../src/app/accumulation-data.mjs';
import {assetCollections,buildAssetBatchRequest,isRemovedAsset} from '../src/app/asset-management.mjs';
import {manualRequest} from '../src/app/manual-request.mjs';

// This verifies request generation and the real runtime AFTER an Agent applies
// the documented lifecycle changes. It does not impersonate a host Agent.
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const root=mkdtempSync(join(tmpdir(),'ai-carry-asset-batch-'));
console.log(`Isolated fixture: ${root}`);
for(const ref of ['core','instance','assistant.toml','AGENTS.md','BOOTSTRAP.md','dashboard/scripts','dashboard/public/snapshot.js']){
  mkdirSync(dirname(join(root,ref)),{recursive:true});cpSync(join(repository,ref),join(root,ref),{recursive:true});
}
const created=executeFirstInstantiation(root,{
  schema_version:1,guidance_mode:'balanced',language:'zh-CN',learning_policy:'risk-tiered',display_name:'分类积累验收助手',mission:'用合成资料验证积累的查看、移除和恢复。',
  direction:{type:'domain',domain_id:'memory-check',label:'分类积累验收',scope_statement:'只处理合成测试资料。'},
  first_task:{title:'核对测试资料',summary:'验证分类积累管理。',trigger:'核对测试资料',aliases:[],scope:[],conditions:[],excludes:[],start_after_instantiation:false},
  profile:{in_scope:['合成测试'],out_of_scope:['真实实例'],automation:[],privacy:[],learning:[],environment:[],unknowns:[]},
  host:{label:'隔离验收',product_name:'',product_version:'',model_name:'',model_selection_label:'',request_model_name:'',model_routing_mode:'unknown',model_observation_basis:[],environment:'isolated',observation_basis:'current-session',integration_mode:'direct-workspace',match_hint:'isolated',limitations:[]},
});
assert(['passed','limited'].includes(created.status),'isolated instance creation failed');
for(const ref of ['instance/validations/index.toml','instance/evolution/index.toml','instance/skills/requirements.toml']){
  const path=join(root,ref);writeFileSync(path,readFileSync(path,'utf8').replace('instance_id = "template"',`instance_id = ${JSON.stringify(created.instance_id)}`));
}
const mapPath=join(root,'instance/maps/domain-map.toml'),baseMap=readFileSync(mapPath,'utf8');
const fields=values=>Object.entries(values).map(([key,value])=>`${key} = ${JSON.stringify(value)}`).join('\n');
const folders={memory:'memory',sop:'sops',capability:'capabilities',experience:'experiences'};
const make=(kind,suffix,title,state='active')=>({id:kind+'.'+suffix,asset_kind:kind,...(kind==='memory'?{subtype:'general'}:kind==='experience'?{subtype:'task'}:{}),title,summary:`${title}，只用于隔离验收。`,triggers:['使用'+title],aliases:[],scope:['合成测试'],conditions:[],excludes:[],related_asset_ids:[],body_sections:[],topic_key:kind+'.'+suffix,subject_key:'memory-check',target:'instance/'+folders[kind]+'/'+kind+'.'+suffix+'.md',state,minimum_level:1,confirmation:'none'});
const groups=Object.entries(assetCollections).map(([collection,{kind,label}])=>({
  collection,kind,label,first:make(kind,'selected',label+'整理方法'),
  paused:make(kind,'paused',label+'暂存方法','paused'),kept:make(kind,'kept',label+'整理方法'),
}));
const assets=groups.flatMap(group=>[group.first,group.paused,group.kept]);
const hostExperience=groups.find(group=>group.kind==='experience').first;
const portableCore=groups.find(group=>group.kind==='capability').first;
hostExperience.subtype='host-execution';
// Cross-category historical links must not cascade removal to the referencing asset.
for(let i=0;i<groups.length;i++)groups[(i+1)%groups.length].kept.related_asset_ids=[groups[i].first.id];
function writeAsset(item,status=item.state,previous){
  const {asset_kind,target,state,...metadata}=item;
  const asset={...metadata,kind:asset_kind,status,lifecycle:'recurring',expected_next_use:'',source_refs:[],private_refs:[],supersedes:[],updated_at:'',approval_state:'explicit',activation_basis:'explicit-user',risk_tier:'low',approved_by_user:true,
    ...(previous?{previous_status:previous}:{}),
    ...(['sop','capability'].includes(asset_kind)||item===hostExperience?{maturity:'unvalidated',independent_task_count:0,successful_use_count:0,failed_use_count:0,distinct_context_count:0,distinct_host_count:0,last_validated_at:'',validation_refs:[],host_experience_refs:item===portableCore?[hostExperience.id]:[]}:{}),
    ...(item===hostExperience?{portable_core_ref:portableCore.id,host_profile_refs:[],environment_scope:[],validity_signals:[]}:{}),
  };
  writeFileSync(join(root,target),'+++\n'+fields(asset)+'\n+++\n# '+item.title+'\n保留这段原始内容供查看和恢复。\n');
}
function writeMap(){writeFileSync(mapPath,baseMap+assets.map(item=>'\n[[routes]]\n'+fields(item)+'\n').join(''));}
for(const item of assets)writeAsset(item);writeMap();
const before=buildSnapshotCandidate(root).snapshot;
assert.equal(before.memories.length+before.sops.length+before.capabilities.length+before.experiences.length,12);
assert.throws(()=>buildAssetBatchRequest(before.memories,'all'));
const bodyOf=item=>readFileSync(join(root,item.target),'utf8').split('+++')[2];
const results=[];
for(const group of groups){
  const {collection,kind,first,paused,kept}=group;
  const foreign=groups.find(other=>other!==group).kept;
  const unchanged=assets.filter(item=>item!==first&&item!==paused).map(item=>[item,readFileSync(join(root,item.target))]);
  const firstBody=bodyOf(first),pausedBody=bodyOf(paused);
  const recalled=()=>queryFormalAssetShortlist(root,{queryText:'使用'+first.title}).candidates.map(item=>item.id);
  assert(recalled().includes(first.id),kind+' active source must be recalled');
  assert(recalled().includes(kept.id));
  const selected=before[collection].filter(item=>[first.id,paused.id].includes(item.id));
  const request=buildAssetBatchRequest([...selected,selected[0]],collection);
  assert(request.body.includes(kind+'.remove-selected'));
  const locators=JSON.parse(request.body.slice(request.body.indexOf('\n[')+1));
  assert.deepEqual(new Set(locators.map(item=>item.asset_id)),new Set([first.id,paused.id]));
  assert(locators.every(item=>item.expected_kind===kind));
  assert(!request.body.includes(kept.id));assert(!request.body.includes(foreign.id));
  assert.throws(()=>buildAssetBatchRequest([...selected,{id:foreign.id,kind:foreign.asset_kind}],collection),'mixed kinds cannot silently create a request');
  assert.throws(()=>buildAssetBatchRequest([],collection));
  const bound=manualRequest({...request,assistant:{root,instanceId:created.instance_id,name:'分类积累验收助手'}});
  assert(bound.includes(root.replaceAll('\\','\\\\')));assert(bound.includes(created.instance_id));

  // Simulate the documented per-item edits, then exercise the real consumers.
  writeAsset(first,'archived','active');
  assert(!recalled().includes(first.id),'a partial edit must not recall archived content');
  assert(recalled().includes(kept.id));
  first.state='archived';paused.state='archived';writeAsset(paused,'archived','paused');writeMap();
  const removed=buildSnapshotCandidate(root).snapshot;
  assert.equal(removed[collection].filter(isRemovedAsset).length,2);
  const map=buildAccumulationData(removed);
  assert(!map.byId['asset:'+first.id]);assert(!map.byId['asset:'+paused.id]);
  assert(map.byId['asset:'+kept.id]);assert(map.byId['asset:'+foreign.id]);assert.equal(map.skipped,0);
  assert(!recalled().includes(first.id));assert(recalled().includes(kept.id));
  const {envelope}=loadTrustedDomainEnvelope(root);
  if(first===hostExperience){
    const coreRead=inspectAssetRoute(root,envelope,portableCore.id);
    assert.deepEqual(coreRead.executionMetadata.hostExperienceRefIds,[],'removed host experience must not be suggested for loading');
  }
  for(const [item,bytes] of unchanged){
    assert.deepEqual(readFileSync(join(root,item.target)),bytes,'unselected source changed: '+item.id);
    if(item.state==='active')assert.equal(inspectAssetRoute(root,envelope,item.id).decision,'load-bounded-body','historical reference must not disable '+item.id);
  }
  assert(!Object.hasOwn(inspectAssetRoute(root,envelope,first.id),'body'));
  const reviewEnvelope=loadTrustedDomainEnvelope(root,{explicitRequestedId:first.id}).envelope;
  assert.equal(inspectAssetForReview(root,reviewEnvelope,first.id,{explicitRequestedId:first.id}).decision,'review-evidence-only');
  assert.equal(bodyOf(first),firstBody);assert.equal(bodyOf(paused),pausedBody);
  const restore=buildAssetBatchRequest(removed[collection].filter(isRemovedAsset),collection,'restore');
  assert(restore.body.includes(kind+'.restore-selected'));
  first.state='active';paused.state='paused';writeAsset(first);writeAsset(paused);writeMap();
  const restored=buildSnapshotCandidate(root).snapshot;
  assert(recalled().includes(first.id));
  assert(!queryFormalAssetShortlist(root,{queryText:'使用'+paused.title}).candidates.some(item=>item.id===paused.id),'restored paused content must stay out of recall');
  assert.equal(restored[collection].filter(isRemovedAsset).length,0);
  assert(buildAccumulationData(restored).byId['asset:'+first.id]);
  assert.equal(bodyOf(first),firstBody);assert.equal(bodyOf(paused),pausedBody);
  for(const [item,bytes] of unchanged)assert.deepEqual(readFileSync(join(root,item.target)),bytes);
  results.push({collection,exactSelection:true,partialEditExcluded:true,removedCount:2,restoredCount:2,pausedStatePreserved:true,unrelatedSourcesUnchanged:true});
}
// Leave one archived and two current items IN EACH category for UI checks.
for(const {paused} of groups){paused.state='archived';writeAsset(paused,'archived','paused');}writeMap();
const current=buildSnapshotCandidate(root);
writeFileSync(join(root,'dashboard/public/snapshot.js'),current.source);
mkdirSync(join(root,'dashboard/dist'),{recursive:true});writeFileSync(join(root,'dashboard/dist/snapshot.js'),current.source);
writeFileSync(join(root,'asset-batch-result.json'),JSON.stringify({scope:'request + documented source state transitions + actual recall/snapshot/map; not a host Agent execution',results,root},null,2));
console.log('Asset batch checks passed: four independent categories, exact selection, partial edits, recall exclusion, recovery and unrelated-source preservation.');
