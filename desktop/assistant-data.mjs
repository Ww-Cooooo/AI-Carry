import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { buildSnapshotCandidate } from '../dashboard/scripts/snapshot-source-builder.mjs';
import { buildVerifiedStartupProjection } from '../dashboard/scripts/query-startup-capsule.mjs';
import { parseSectionedToml, validateInstanceManifestStructure, queryFormalAssetShortlist, inspectShortlistedFormalAsset } from '../dashboard/scripts/asset-route-contract.mjs';

// Use trusted product readers, never execute scripts/snapshot JS from the bound folder.
export function checkAssistant(binding, { localRead = false } = {}) {
  if (!binding || (!localRead && !binding.synthetic) || typeof binding.root !== 'string') throw new Error('请先选择 AI Carry 助手文件夹。');
  const root = realpathSync(binding.root);
  if (root !== path.resolve(binding.root)) throw new Error('助手文件夹的位置有变化。请重新选择当前文件夹，原资料没有改动。');
  let part = root;
  for (const name of ['instance', 'manifest.toml']) {
    part = path.join(part, name);
    if (lstatSync(part).isSymbolicLink()) throw new Error('助手身份文件指向了别的位置。请让 Agent 确认正确的助手文件夹，再重新选择。');
  }
  if (lstatSync(part).size > 64 * 1024) throw new Error('没能读取助手身份文件。请让 Agent 检查这份资料；其他页面仍可使用。');
  const manifest = validateInstanceManifestStructure(parseSectionedToml(readFileSync(part, 'utf8'), 'assistant identity'));
  if (manifest.root.instance_id !== binding.instanceId) throw new Error('这个文件夹中的助手已不是之前那一份。请重新选择要查看的助手，原资料没有改动。');
  return root;
}

export function readAssistantData(binding, options) {
  const root = checkAssistant(binding, options);
  const candidate = buildSnapshotCandidate(root, { mode: 'operational', existingSource: '' });
  return { binding: {...binding,name:candidate.snapshot.profile.display_name||binding.name}, snapshot: candidate.snapshot, startup: buildVerifiedStartupProjection(root), diagnostics: candidate.diagnostics };
}

export function readAssistantEntry(binding, id, options) {
  const { snapshot } = readAssistantData(binding, options);
  const entry = ['memories', 'sops', 'capabilities', 'experiences'].flatMap(k => snapshot[k]).find(item => item.id === id);
  if (!entry) throw new Error('没能读到这条积累。请刷新资料，或让 Agent 检查这一条；其他积累仍可使用。');
  const shortlist = queryFormalAssetShortlist(binding.root, { queryText: id });
  const detail = inspectShortlistedFormalAsset(binding.root, shortlist, id);
  if (typeof detail.body !== 'string') throw new Error('没能读取这条积累的正文。请让 Agent 检查它的文件位置。');
  return { ...entry, body: detail.body };
}
