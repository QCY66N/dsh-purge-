import { removeTreeNoFollowSync } from "../lib/remove-tree.js";
// Real official Release, selected Node/Electron runtime, disposable profile only.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { bootstrapInstall } from './bootstrap-install.mjs';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'purge-download-acceptance-'));
const profile=path.join(home,'profiles/desktop');fs.mkdirSync(profile,{recursive:true});
fs.writeFileSync(path.join(profile,'package.json'),'{}');fs.writeFileSync(path.join(profile,'cordis.patch.yml'),'PRIVATE SETTINGS SENTINEL');

// 显式给了版本就照做；没给就取本仓库最新正式发行。
// 以前写死 1.6.38——那是上游的版本号，换源之后这个 tag 在本仓库不存在，首发必然 404。
// 未认证的 GitHub API 在共享 runner 上容易撞额度：那种情况下明确 SKIP，不要伪装成通过，
// 也不要把"查不到发行"当成"下载链路有问题"。
async function resolveTargetVersion(explicit) {
  if (explicit) return explicit;
  const { releasedVersions } = await import('../lib/community.js');
  try {
    const list = await releasedVersions();
    return list.length ? list[0].version : '';
  } catch (error) {
    const message = String(error && error.message || '');
    if (/额度耗尽|rate limit|HTTP (403|429)/i.test(message)) {
      console.log('SKIP: GitHub API 额度受限，无法确认本仓库的正式发行；配置 GITHUB_TOKEN 后此验收才有意义。');
      console.log('  ' + message.split('\n')[0]);
      return '';
    }
    throw error;
  }
}
const version=await resolveTargetVersion(process.argv[2]);
if(!version) {
  // 新 fork 的首次发行走不到这里能验收的地步：仓库还没有任何正式 release，
  // 而这条验收要下载真实发行包。明确跳过并说明原因，不要伪装成通过。
  console.log('SKIP: 本仓库还没有任何正式发行（含 tgz 与 SHA256SUMS），无法验收真实下载链路；首发创建后自然会跑。');
  process.exit(0);
}
try {
  for(const fallback of [false,true]) {
    const logs=[];
    const result=await bootstrapInstall({home,cli:process.execPath,version,dryRun:true,
      ...(fallback?{request:async()=>{throw Object.assign(new TypeError('injected fetch-only network failure'),{code:'ENETUNREACH'});}}:{}),
      log:message=>{logs.push(message);console.log(message);},run:async()=>assert.fail('dry run must not invoke installation'),
    });
    assert.equal(result.version,version);assert.equal(result.dryRun,true);
    if(fallback) {
      assert(logs.some(x=>x.includes('stage=archive transport=curl recovered')));
      assert(logs.some(x=>x.includes('stage=checksum transport=curl recovered')));
    }
    assert.equal(fs.readFileSync(path.join(profile,'cordis.patch.yml'),'utf8'),'PRIVATE SETTINGS SENTINEL');
    assert.deepEqual(fs.readdirSync(home),['profiles']);
    console.log(JSON.stringify({platform:process.platform,node:process.versions.node,electron:process.versions.electron||null,version,forcedFallback:fallback,sha256Verified:true,settingsPreserved:true,installed:false}));
  }
} finally {removeTreeNoFollowSync(home);}
