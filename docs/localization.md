# Localization policy

AI Carry uses a Chinese-canonical, multilingual-user-layer design.

## Product rules

1. Simplified Chinese is the default interface and the canonical source for internal protocols, schemas, routes, and release logic.
2. English installation begins at `README.en.md`, `INSTALL.en.md`, or `START-HERE.en.txt` and opens `dashboard.en.html`. That entry sets an English hint for the same dashboard codebase.
3. A user-selected dashboard language overrides the entry hint and is remembered for that local dashboard when browser storage is available.
4. Browser language is not used to silently override the Chinese default. IP address or geographic location is never used to choose language.
5. The live page sets the actual HTML language tag. Titles, accessibility labels, dates, status text, and copied host requests switch with the selected user language.
6. Only reviewed product copy is translated. Unknown strings and user-authored memories, capabilities, SOPs, experience, professional materials, and local-private data remain in their original language.
7. English copied requests begin with an English host contract and retain the Chinese canonical operational request. The host must execute the canonical meaning completely and communicate with the user in English. This prevents two security or migration protocols from drifting apart.
8. No online translation service or runtime network request is required.

## Terminology

| Chinese canonical term | English user term |
| --- | --- |
| AI Carry | AI Carry |
| 宿主 Agent | host Agent |
| 模型或模型 API | model or model API |
| 便携式 AI 助手 | portable AI assistant |
| 记忆 | memory |
| 能力 | capability |
| 固定流程（SOP） | repeatable workflow (SOP) |
| 经验 / 任务经验 | task experience |
| 学习建议 | learning suggestion |
| 长期改进 | long-term improvement |
| 本地隐私资料 | local-private data |
| 迁移套件 | migration kit |

Use “assistant,” never “companion.” Use ordinary language before technical terms, and explain who acts, where the action happens, what changes, and who approves.

## Sensitive naming and regional content

Localization must not invent political, territorial, legal, or regional claims. AI Carry-owned Chinese product copy uses `中国台湾`、`中国香港`、`中国澳门`; reviewed English product copy uses `Taiwan, China`, `Hong Kong SAR, China`, and `Macao SAR, China`. These regions must not be presented as sovereign states. A mixed selector is labelled “国家和地区” / `countries and regions`, and its grouping, flags, maps, accessibility text, and generated requests must preserve the same meaning.

The complete formal owner is [`core/protocols/TERRITORY_TERMINOLOGY.md`](../core/protocols/TERRITORY_TERMINOLOGY.md). It loads only when AI Carry-authored content actually mentions geography, jurisdiction, maps, flags, or country/region grouping. User-authored memories, filenames, imported evidence, legal names, and direct quotations remain source text; AI Carry-generated labels and summaries around them follow the reviewed terminology. Automated translation cannot decide these names or silently rewrite source evidence.

## Release checks

README localization checks protect the language switch, official installation request, versioned download and release-history link. The version comes from `assistant.toml` and destinations from `core/upgrade/official-source.toml`; historical headings and marketing sentences are not frozen. Capability accuracy still needs a review of the actual changes, not a list of required phrases. Receipt labels requested by users remain covered by the existing proactive-learning check.

A public candidate must verify:

- Chinese entry defaults to `zh-Hans` and English entry defaults to `en`;
- the visible language control works offline and the user choice wins over the entry hint;
- all primary template pages and first-use dialogs contain no unintended Chinese in English mode other than the visible `中文` language target;
- snapshot-origin content remains unchanged in English mode, including the collision case where a user title is exactly the same as a translated interface term such as `记忆`, `能力`, or `固定流程（SOP）`;
- English copied requests keep the canonical request and require English user communication;
- README, install entry, root dashboard entry, Pages demo, release manifest, ownership map, and public allowlist agree;
- AI Carry-owned Chinese and English text passes the territory terminology validator, while source-text projections remain unchanged;
- maps, flags, country/region grouping, accessibility labels, and generated requests receive Level 3 semantic review whenever present;
- no private maintainer workflow or mock user data is exposed in the public package.
