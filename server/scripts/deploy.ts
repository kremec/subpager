import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const files = [
  "package.json",
  "bun.lock",
  "app/package.json",
  "app/patches",
  "server/package.json",
  "server/src",
  "server/scripts",
];

const deploy = `
set -eu
umask 077
cd "$HOME/subpager"
target="$PWD"
test -d app
test -f server/config.json
test -f server/receiver-service-account.json
stage=$(mktemp -d "$HOME/.subpager-deploy.XXXXXX")
trap 'rm -rf "$stage"' EXIT
tar -xzf - -C "$stage"
cd "$stage"
bun install --filter subpager-server --production --frozen-lockfile --ignore-scripts

doas rc-service subpager stop
for path in server/src server/scripts server/node_modules node_modules app/patches; do
  rm -rf "$target/$path"
  if [ -e "$stage/$path" ]; then
    mv "$stage/$path" "$target/$path"
  fi
done
cp package.json bun.lock "$target/"
cp server/package.json "$target/server/"
cp app/package.json "$target/app/"
doas rc-service subpager start
doas rc-service subpager status
`;

console.log("Deploying server to subpager-server...");
const temporary = await mkdtemp(join(tmpdir(), "subpager-deploy-"));
try {
  const archive = join(temporary, "server.tar.gz");
  await $`tar -czf ${archive} --exclude='*.test.ts' -C ${root} ${files}`;
  await $`ssh -T -o BatchMode=yes -o ConnectTimeout=10 subpager-server ${deploy} < ${archive}`;
} finally {
  await rm(temporary, { recursive: true });
}
console.log("Deployed. Run ssh subpager-server to view startup logs.");
