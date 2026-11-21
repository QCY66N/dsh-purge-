// 上游仓库已被删除并换成无关项目：发布源必须指向本仓库，否则 beta/zip 通道 404。
// 本 fork 把发布源切到自有仓库；上游只保留为"旧安装来源"的识别项。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE_REPO, UPSTREAM_REPO, archiveZipUrl, archiveTarballUrl } from "../lib/update-net.js";
import { REPOSITORY, UPSTREAM_REPOSITORY, LATEST_TARBALL_RE, releaseIdentityUrls } from "../lib/community.js";

test("update sources point at this repository", () => {
  assert.equal(SOURCE_REPO, "QCY66N/dsh-purge-");
  assert.equal(UPSTREAM_REPO, SOURCE_REPO);
  assert.equal(REPOSITORY, SOURCE_REPO);
});

test("archive URLs never reference the removed upstream", () => {
  for (const url of [archiveZipUrl("v1.6.36"), archiveTarballUrl("v1.6.36")]) {
    assert.match(url, /QCY66N\/dsh-purge-/);
    assert.doesNotMatch(url, /YuJunZhiXue/);
  }
});

// 换源不是单向的：现有用户是从上游 latest 通道装的，profile 里记的还是上游 URL。
// 认不出它就会把"官方通道装的"误判成"本地文件装的"，从而跳过 keepDisabled 迁移。
test("latest-channel installs are recognised from both this fork and upstream", () => {
  assert.equal(UPSTREAM_REPOSITORY, "kingcharleslzy-ai/dsh-purge");
  for (const repo of [REPOSITORY, UPSTREAM_REPOSITORY]) {
    for (const name of ["dsh-purge-community.tgz", "dsh-purge-community-1.7.21.tgz"]) {
      const url = `https://github.com/${repo}/releases/latest/download/${name}`;
      assert.ok(LATEST_TARBALL_RE.test(url), `must recognise ${url}`);
    }
  }
});

test("latest-channel recognition rejects look-alike hosts and paths", () => {
  for (const url of [
    "https://github.com/evil/dsh-purge-/releases/latest/download/dsh-purge-community.tgz",
    "https://gist.github.com/QCY66N/dsh-purge-/releases/latest/download/dsh-purge-community.tgz",
    "https://github.com/QCY66N/dsh-purge-/releases/download/v1.7.21/dsh-purge-community.tgz",
    "https://github.com/QCY66N/dsh-purge-/releases/latest/download/other-package.tgz",
    "https://github.com/QCY66N/dsh-purge-/releases/latest/download/dsh-purge-community.tgz.sig",
  ]) {
    assert.equal(LATEST_TARBALL_RE.test(url), false, `must not recognise ${url}`);
  }
});

// 换源不能把"从上游装过来"的路断掉：回滚事务、install-recovery、以及以旧版本为
// baseline 的升级演练都要校验上游包，那些包的 repository.url 写的是上游。
// 但白名单必须封闭——收紧到只剩本仓库会让 CI 的 rollback 演练直接报
// "安装包身份与发行版本不一致"。
test("release identity accepts this fork and the upstream it forked from, nothing else", () => {
  const urls = releaseIdentityUrls();
  for (const repo of [REPOSITORY, UPSTREAM_REPOSITORY]) {
    assert.ok(urls.includes(`git+https://github.com/${repo}.git`));
    assert.ok(urls.includes(`https://github.com/${repo}.git`));
  }
  assert.equal(urls.length, 4, "allowlist must stay closed: exactly two repos, two URL forms");
  assert.equal(urls.includes("https://github.com/evil/dsh-purge-.git"), false);
  assert.equal(urls.includes("https://github.com/QCY66N/dsh-purge-.git "), false, "no whitespace tolerance");
});
