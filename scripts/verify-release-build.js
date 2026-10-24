/** Recovery publication accepts only installers from this repository's tagged
 * workflow run, with both native build/check jobs successful. Never substitute
 * artifacts from an unrelated branch, repository or failed platform build. */
import { execFileSync } from 'node:child_process';

const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.ALETHEIA_RELEASE_TAG;
const runId = process.env.ALETHEIA_BUILD_RUN_ID;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^v\d+\.\d+\.\d+$/.test(tag || '') || !/^\d+$/.test(runId || '')) throw new Error('Invalid release recovery context.');
function api(endpoint) { return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' })); }
const run = api(`repos/${repository}/actions/runs/${runId}`);
const jobs = api(`repos/${repository}/actions/runs/${runId}/jobs`);
const builds = jobs.jobs.filter(job => job.name.startsWith('build ('));
if (run.event !== 'push' || run.head_repository.full_name !== repository || builds.length !== 2 || builds.some(job => job.conclusion !== 'success')) throw new Error('Both native installer builds must have passed in this repository.');
const ref = api(`repos/${repository}/git/ref/tags/${tag}`);
const commit = ref.object.type === 'tag' ? api(`repos/${repository}/git/tags/${ref.object.sha}`).object.sha : ref.object.sha;
if (commit !== run.head_sha) throw new Error('The selected artifacts do not correspond to the release tag.');
console.log(`Verified ${tag}: ${commit}, successful Windows and Ubuntu package checks in run ${runId}.`);
