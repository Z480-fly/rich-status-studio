#!/usr/bin/env node
/**
 * Deploy the Zora presence worker to Northflank — no terminal work required.
 *
 * The script talks to the documented Northflank REST API (https://api.northflank.com/v1)
 * and is idempotent: re-running it converges the service on the desired state.
 *
 *   node worker/deploy/northflank/deploy.mjs dry-run
 *       Validates every payload this script sends against Northflank's live
 *       OpenAPI spec. Needs no token and creates nothing.
 *
 *   node worker/deploy/northflank/deploy.mjs up \
 *       --api-base https://your-zora-app \
 *       --sdk-url  '<link to DiscordSocialSdk-*.zip>'
 *       Creates the project + combined service, sets the SDK build argument and
 *       the runtime environment, starts a build, waits for the deployment, then
 *       verifies the worker endpoints.
 *
 *   node worker/deploy/northflank/deploy.mjs status | logs | check-api | build
 *
 * Secrets are read from the environment and are never printed:
 *   NORTHFLANK_API_TOKEN     required for everything except `dry-run`
 *   WORKER_SHARED_SECRET     required by `up` and `check-api`
 *   DISCORD_APP_ID           optional, informational for the worker
 */

// Bare origin. Every path passed to nf() carries the /v1 prefix, exactly as the
// OpenAPI spec writes it (see SPEC_PATHS), so the two can never drift apart.
const API = 'https://api.northflank.com';

// ---------------------------------------------------------------------------
// Flags / environment
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('--')) || 'help';
const DRY = command === 'dry-run';

function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}

const opts = {
  project: flag('project', 'zora'),
  service: flag('service', 'zora-presence-worker'),
  repo: flag('repo', 'https://github.com/Z480-fly/rich-status-studio'),
  branch: flag('branch', 'main'),
  sha: flag('sha'),
  region: flag('region', 'europe-west'),
  apiBase: flag('api-base') ?? process.env.ZORA_API_BASE,
  sdkUrl: flag('sdk-url') ?? process.env.DISCORD_SOCIAL_SDK_URL,
  sdkSha256: flag('sdk-sha256') ?? process.env.DISCORD_SOCIAL_SDK_SHA256,
  discordAppId: flag('discord-app-id') ?? process.env.DISCORD_APP_ID,
  deploymentPlan: flag('deployment-plan'),
  buildPlan: flag('build-plan'),
  ci: argv.includes('--ci'),
  pollSeconds: Number(flag('poll-seconds', 15)),
  timeoutSeconds: Number(flag('timeout-seconds', 1800)),
  limit: Number(flag('limit', 120)),
};

// Representative values so `dry-run` can validate the payload shape before any
// real secret or URL exists. They are never sent anywhere.
const PLACEHOLDER = {
  apiBase: 'https://zora.example',
  sdkUrl: 'https://example.com/DiscordSocialSdk-1.10.19337.zip',
  secret: 'placeholder-shared-secret',
};

const log = (...a) => console.log(...a);
const step = (m) => log(`\n== ${m}`);
function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Northflank API client
// ---------------------------------------------------------------------------

function requireToken() {
  const t = process.env.NORTHFLANK_API_TOKEN;
  if (!t) {
    fail(
      'NORTHFLANK_API_TOKEN is not set. Create a personal API token in Northflank\n' +
        '       (Account settings -> API tokens) and add it to this workspace in\n' +
        '       Settings -> Environment as NORTHFLANK_API_TOKEN. The token is read from\n' +
        '       the environment and is never written to the repository.',
    );
  }
  return t;
}

const hasToken = () => Boolean(process.env.NORTHFLANK_API_TOKEN);

async function nf(method, path, body) {
  // Guard the invariant: a path missing the /v1 prefix would silently hit
  // /v1/plans-style routes that do not exist instead of failing loudly here.
  if (!path.startsWith('/v1/')) fail(`internal: API path "${path}" must start with /v1/`);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requireToken()}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    // Northflank reports payload problems as a generic "see details" message, so
    // include the details (and the raw body as a last resort) or a 400 is opaque.
    const message = json?.error?.message || json?.message;
    const details = json?.error?.details ?? json?.details ?? json?.errors;
    const detail = [
      message,
      details === undefined ? undefined : JSON.stringify(details),
      message ? undefined : text.slice(0, 600),
    ]
      .filter(Boolean)
      .join(' | ');
    const err = new Error(`${method} ${path} -> ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Response schemas are not published for every endpoint, so these helpers reach
// in defensively rather than assuming one shape.
const firstArray = (...candidates) => candidates.find((c) => Array.isArray(c)) || [];
const pick = (obj, ...keys) => keys.reduce((acc, k) => (acc === undefined ? obj?.[k] : acc), undefined);

function deepFindStatus(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return undefined;
  if (typeof node.status === 'string') return node.status;
  for (const key of ['build', 'deployment', 'data']) {
    const found = deepFindStatus(node[key], depth + 1);
    if (found) return found;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindStatus(item, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

const BUILD_OK = ['SUCCESS', 'COMPLETED'];
const BUILD_BAD = ['FAILURE', 'ABORTED', 'SUBMISSION_FAILURE', 'CRASHED', 'UNSCHEDULABLE'];
const DEPLOY_OK = ['RUNNING', 'SUCCESS'];
const DEPLOY_BAD = ['FAILED', 'CRASHED', 'DELETED'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Payloads — `dry-run` validates every field below against the live spec
// ---------------------------------------------------------------------------

function buildArguments(dry = false) {
  const url = opts.sdkUrl || (dry ? PLACEHOLDER.sdkUrl : undefined);
  if (!url) {
    fail(
      'no Discord Social SDK supplied. Pass --sdk-url "<link to DiscordSocialSdk-*.zip>"\n' +
        '       (or set DISCORD_SOCIAL_SDK_URL). The worker cannot publish presence without\n' +
        '       the official SDK, and the ~745 MB archive is far too large to store as a\n' +
        '       build argument value.',
    );
  }
  const args = { DISCORD_SOCIAL_SDK_URL: String(url) };
  if (opts.sdkSha256) args.DISCORD_SOCIAL_SDK_SHA256 = String(opts.sdkSha256);
  return args;
}

function runtimeEnvironment(dry = false) {
  const apiBase = opts.apiBase || (dry ? PLACEHOLDER.apiBase : undefined);
  if (!apiBase) {
    fail('--api-base is required (the deployed Zora app URL, e.g. https://your-app.example)');
  }
  const secret = process.env.WORKER_SHARED_SECRET || (dry ? PLACEHOLDER.secret : undefined);
  if (!secret) {
    fail(
      'WORKER_SHARED_SECRET is not set. Add the same value the Zora app uses for its\n' +
        '       worker endpoints in Settings -> Environment. It is sent to Northflank as an\n' +
        '       encrypted runtime variable and never appears in the repository or in logs.',
    );
  }
  const env = {
    ZORA_API_BASE: String(apiBase),
    WORKER_SHARED_SECRET: secret,
    POLL_INTERVAL_MS: '5000',
  };
  if (opts.discordAppId) env.DISCORD_APP_ID = String(opts.discordAppId);
  return env;
}

function combinedServicePayload(args, env, plans) {
  return {
    name: opts.service,
    description: 'Zora Discord Rich Presence worker (Discord Social SDK, native Linux)',
    billing: {
      deploymentPlan: plans.deploymentPlan,
      buildPlan: plans.buildPlan,
    },
    vcsData: {
      projectUrl: opts.repo,
      projectType: 'github',
      projectBranch: opts.branch,
    },
    buildSource: 'git',
    buildSettings: {
      // 16 GB is the API minimum; the SDK archive is ~745 MB and unpacks large.
      storage: { ephemeralStorage: { storageSize: 16384 } },
      dockerfile: {
        buildEngine: 'buildkit',
        dockerFilePath: '/worker/Dockerfile',
        dockerWorkDir: '/worker',
      },
    },
    buildConfiguration: {
      // CI is off by default: the SDK download link is a short-lived signed URL,
      // so a push-triggered rebuild would fail once it expires. --ci turns branch
      // builds on once the link is long-lived.
      branchRestrictions: opts.ci ? [opts.branch] : [],
      prRestrictions: [],
      ciIgnoreFlagsEnabled: true,
    },
    buildArguments: args,
    runtimeEnvironment: env,
    deployment: {
      instances: 1,
      docker: { configType: 'default' },
      storage: { ephemeralStorage: { storageSize: 1024 } },
    },
    healthChecks: [],
    autoscaling: {},
  };
}

// ---------------------------------------------------------------------------
// dry-run: validate the payloads against Northflank's live OpenAPI spec
// ---------------------------------------------------------------------------

const SPEC_PATHS = {
  createProject: '/v1/projects',
  listProjects: '/v1/projects',
  createService: '/v1/projects/{projectId}/services/combined',
  updateService: '/v1/projects/{projectId}/services/combined/{serviceId}',
  listServices: '/v1/projects/{projectId}/services',
  getService: '/v1/projects/{projectId}/services/{serviceId}',
  buildArguments: '/v1/projects/{projectId}/services/{serviceId}/build-arguments',
  runtimeEnvironment: '/v1/projects/{projectId}/services/{serviceId}/runtime-environment',
  startBuild: '/v1/projects/{projectId}/services/{serviceId}/build',
  buildLogs: '/v1/projects/{projectId}/services/{serviceId}/build-logs',
  logs: '/v1/projects/{projectId}/services/{serviceId}/logs',
  deployments: '/v1/projects/{projectId}/services/{serviceId}/deployments',
  plans: '/v1/plans',
};

async function loadSpec() {
  const res = await fetch(`${API}/v1/swagger-json`);
  if (!res.ok) fail(`could not load the Northflank OpenAPI spec (${res.status})`);
  return res.json();
}

const normalize = (s) => s.toLowerCase().replace(/[{}]/g, '').replace(/[^a-z0-9]/g, '');

function pathItem(spec, path, method) {
  const item = spec.paths[path];
  if (!item) return undefined;
  const op = item[method];
  if (!op) return undefined;
  if (op.$ref) return spec.components.pathItems[op.$ref.split('/').pop()];
  if (Object.keys(op).length) return op;
  const want = normalize(`${path} ${method}`);
  const key = Object.keys(spec.components.pathItems || {}).find((k) => normalize(k) === want);
  return key ? spec.components.pathItems[key] : undefined;
}

function bodySchema(spec, path, method) {
  const item = pathItem(spec, path, method);
  const content = item?.requestBody?.content;
  if (!content) return undefined;
  return content['application/json']?.schema ?? Object.values(content)[0]?.schema;
}

const resolveSchema = (spec, schema) =>
  schema?.$ref ? spec.components.schemas[schema.$ref.split('/').pop()] : schema;

async function dryRun() {
  const problems = [];

  step('Loading the Northflank OpenAPI spec');
  const spec = await loadSpec();
  log('  ok  spec loaded');

  step('Checking the endpoints this script calls');
  for (const [name, path] of Object.entries(SPEC_PATHS)) {
    const methods = Object.keys(spec.paths[path] || {});
    if (methods.length === 0) problems.push(`missing endpoint ${path} (${name})`);
    else log(`  ok  ${path}  [${methods.join(', ').toUpperCase()}]`);
  }

  const args = buildArguments(true);
  const env = runtimeEnvironment(true);
  const plans = await resolvePlans();
  const payload = combinedServicePayload(args, env, plans);

  step('Validating the combined-service payload against the spec');
  const schema = resolveSchema(spec, bodySchema(spec, SPEC_PATHS.createService, 'post'));
  if (!schema) fail('could not read the combined-service request schema');
  const allowed = new Set(Object.keys(schema.properties || {}));
  for (const key of Object.keys(payload)) {
    if (allowed.has(key)) log(`  ok  ${key}`);
    else problems.push(`unknown field "${key}" in the combined-service payload`);
  }
  for (const required of schema.required || []) {
    if (payload[required] === undefined) problems.push(`missing required field "${required}"`);
  }

  step('Checking enum values');
  const enumChecks = [
    ['vcsData.projectType', schema.properties.vcsData?.properties?.projectType?.enum, payload.vcsData.projectType],
    ['buildSource', schema.properties.buildSource?.enum, payload.buildSource],
    [
      'buildSettings.dockerfile.buildEngine',
      schema.properties.buildSettings?.oneOf?.[0]?.properties?.dockerfile?.properties?.buildEngine?.enum,
      payload.buildSettings.dockerfile.buildEngine,
    ],
    [
      'deployment.docker.configType',
      schema.properties.deployment?.properties?.docker?.properties?.configType?.enum,
      payload.deployment.docker.configType,
    ],
  ];
  for (const [label, allowedValues, value] of enumChecks) {
    if (!allowedValues) {
      log(`  --  ${label} = ${value} (enum not published in the spec)`);
    } else if (allowedValues.includes(value)) {
      log(`  ok  ${label} = ${value}`);
    } else {
      problems.push(`${label} = "${value}" is not one of ${allowedValues.join(' | ')}`);
    }
  }

  step('Checking the build-argument and runtime-variable payload shapes');
  const argSchema = resolveSchema(spec, bodySchema(spec, SPEC_PATHS.buildArguments, 'post'));
  const envSchema = resolveSchema(spec, bodySchema(spec, SPEC_PATHS.runtimeEnvironment, 'post'));
  const expectMap = (schemaObj, key, keys) => {
    const container = schemaObj?.properties?.[key];
    if (!container?.additionalProperties) problems.push(`${key} is not an open key/value map in the spec`);
    else log(`  ok  ${key} accepts: ${keys.join(', ')}`);
  };
  expectMap(argSchema, 'buildArguments', Object.keys(args));
  expectMap(envSchema, 'runtimeEnvironment', Object.keys(env));

  step('Validating the build trigger payload');
  const buildSchema = resolveSchema(spec, bodySchema(spec, SPEC_PATHS.startBuild, 'post'));
  const variants = buildSchema?.anyOf ?? [buildSchema];
  if (variants.some((v) => v?.properties?.branch)) {
    log(`  ok  build trigger accepts { branch: "${opts.branch}" }`);
  } else {
    problems.push('the build trigger does not accept a branch parameter for combined services');
  }

  if (!(await checkBranchDockerfile())) {
    problems.push(`branch "${opts.branch}" has no worker/Dockerfile`);
  }

  step('Plans this deployment would use');
  log(`  deployment plan: ${plans.deploymentPlan}`);
  log(`  build plan:      ${plans.buildPlan}`);
  log('  (dry-run creates nothing)');

  if (problems.length) {
    step('Problems found');
    for (const p of problems) console.error(`  FAIL  ${p}`);
    process.exit(1);
  }
  log('\nAll payloads match the live Northflank API spec.');
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function planOverrides() {
  const out = {};
  if (opts.deploymentPlan) out.deploymentPlan = opts.deploymentPlan;
  if (opts.buildPlan) out.buildPlan = opts.buildPlan;
  return out;
}

async function resolvePlans() {
  const fallback = {
    deploymentPlan: opts.deploymentPlan || 'nf-compute-10',
    buildPlan: opts.buildPlan || 'nf-compute-400-16',
  };
  // Without a token (dry-run) keep the documented defaults; with one, ask the
  // account which plans actually exist so the smallest valid ones are used.
  if (!hasToken()) return { ...fallback, ...planOverrides() };
  const data = await nf('GET', '/v1/plans');
  const plans = firstArray(data?.data?.plans, data?.plans);
  if (!plans.length) return { ...fallback, ...planOverrides() };
  const out = { ...fallback, ...planOverrides() };
  const cheapest = (list) => list.sort((a, b) => (a.amountPerHour ?? 0) - (b.amountPerHour ?? 0))[0];
  if (!opts.deploymentPlan) {
    const viable = plans.filter((p) => (p.ramResource ?? 0) >= 512);
    const picked = cheapest(viable.length ? viable : plans);
    if (picked?.id) out.deploymentPlan = picked.id;
  }
  // Do NOT auto-pick the build plan from /v1/plans: that endpoint returns
  // generic compute plans whose ids (e.g. nf-compute-400) are rejected for
  // builds with "404 Build plan not found". Build plans use the -<ramGB> suffix
  // form, and nf-compute-400-16 is the documented default (>=4 vCPU required).
  // --build-plan overrides this.
  return out;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Resolves the project id. `create: false` keeps the read-only commands
 * (status, logs) genuinely read-only — they must never provision a project
 * just because someone asked to look at one.
 */
async function ensureProject({ create = true } = {}) {
  step(`Ensuring project "${opts.project}"`);
  const list = await nf('GET', '/v1/projects');
  const projects = firstArray(list?.data?.projects, list?.data);
  const existing = projects.find((p) => p.name === opts.project || p.id === opts.project);
  if (existing) {
    const id = existing.id ?? existing.name;
    log(`  ok  project exists: ${id}`);
    return id;
  }
  if (!create) {
    fail(
      `project "${opts.project}" does not exist yet. This command only reads; run \`up\`\n` +
        '       to create the project and service (it creates billable resources).',
    );
  }
  const created = await nf('POST', '/v1/projects', {
    name: opts.project,
    // The API validates this against an ASCII-only pattern; an em dash here is
    // rejected with an opaque 400 payload-validation error.
    description: 'Zora - Discord Rich Presence controller',
    color: '#3b82f6',
    region: opts.region,
  });
  const id = created?.data?.id ?? created?.data?.name ?? opts.project;
  log(`  ok  created project ${id}`);
  return id;
}

async function findService(projectId) {
  const list = await nf('GET', `/v1/projects/${projectId}/services`);
  const services = firstArray(list?.data?.services, list?.data);
  return services.find((s) => s.name === opts.service || s.id === opts.service);
}

async function ensureService(projectId) {
  step(`Ensuring combined service "${opts.service}"`);
  const args = buildArguments();
  const env = runtimeEnvironment();
  const plans = await resolvePlans();
  log(`  plans: deployment=${plans.deploymentPlan} build=${plans.buildPlan}`);

  let service = await findService(projectId);
  if (!service) {
    const created = await nf(
      'POST',
      `/v1/projects/${projectId}/services/combined`,
      combinedServicePayload(args, env, plans),
    );
    service = created?.data ?? { id: opts.service, name: opts.service };
    log(`  ok  created service ${service.id ?? opts.service}`);
  } else {
    log(`  ok  service exists: ${service.id}`);
    // Existing services are converged through the dedicated setters (which
    // replace the whole key/value map) rather than a PUT of the entire spec.
    await nf('POST', `/v1/projects/${projectId}/services/${service.id}/build-arguments`, {
      buildArguments: args,
    });
    log('  ok  build arguments converged (DISCORD_SOCIAL_SDK_URL)');
  }
  await nf('POST', `/v1/projects/${projectId}/services/${service.id}/runtime-environment`, {
    runtimeEnvironment: env,
  });
  log(`  ok  runtime environment converged (${Object.keys(env).join(', ')})`);
  return service.id;
}

/**
 * Combined services reject branch-only builds with
 * "400 Combined services can only build from a commit sha", so resolve the
 * branch head through the public GitHub API (or accept --sha).
 */
async function resolveBuildSha() {
  if (opts.sha) {
    log(`  ok  using supplied sha ${String(opts.sha).slice(0, 12)}`);
    return opts.sha;
  }
  const slug = opts.repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/commits/${opts.branch}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'zora-presence-worker-deploy',
      },
    });
    if (res.ok) {
      const json = await res.json();
      if (json?.sha) {
        log(`  ok  resolved ${opts.branch} -> ${json.sha.slice(0, 12)}`);
        return json.sha;
      }
    } else {
      log(`  --  GitHub lookup failed (HTTP ${res.status})`);
    }
  } catch (e) {
    log(`  --  GitHub lookup failed (${e.message})`);
  }
  return undefined;
}

async function startBuild(projectId, serviceId) {
  step(`Starting a build of ${opts.branch}`);
  const sha = await resolveBuildSha();
  if (!sha) {
    fail(
      'combined services can only build from a commit sha and it could not be resolved.\n' +
        '       Pass --sha <full commit sha> for the branch being built.',
    );
  }
  // Send only the sha: the branch form is rejected for combined services.
  const res = await nf('POST', `/v1/projects/${projectId}/services/${serviceId}/build`, { sha });
  const buildId = res?.data?.id;
  log(`  ok  build ${buildId ?? '(no id returned)'} queued`);
  return buildId;
}

function logLines(payload) {
  return firstArray(payload?.data, payload?.data?.logs).map((l) => (typeof l === 'string' ? l : l.log));
}

async function buildLogs(projectId, serviceId, buildId) {
  const params = new URLSearchParams({ queryType: 'range', lineLimit: String(opts.limit) });
  if (buildId) params.set('buildId', buildId);
  return logLines(await nf('GET', `/v1/projects/${projectId}/services/${serviceId}/build-logs?${params}`));
}

async function runtimeLogs(projectId, serviceId) {
  const params = new URLSearchParams({
    deploymentId: 'latest',
    type: 'runtime',
    queryType: 'range',
    direction: 'backward',
    lineLimit: String(opts.limit),
  });
  return logLines(await nf('GET', `/v1/projects/${projectId}/services/${serviceId}/logs?${params}`));
}

async function waitForBuild(projectId, serviceId, buildId) {
  step('Waiting for the build');
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let last;
  while (Date.now() < deadline) {
    const info = buildId
      ? await nf('GET', `/v1/projects/${projectId}/services/${serviceId}/build/${buildId}`)
      : await nf('GET', `/v1/projects/${projectId}/services/${serviceId}`);
    const status = deepFindStatus(info) ?? 'UNKNOWN';
    if (status !== last) {
      log(`  ..  build status: ${status}`);
      last = status;
    }
    if (BUILD_OK.includes(status)) return true;
    if (BUILD_BAD.includes(status)) {
      step('Build failed — last log lines');
      for (const line of (await buildLogs(projectId, serviceId, buildId)).slice(-opts.limit)) {
        console.error(`  ${line}`);
      }
      return false;
    }
    await sleep(opts.pollSeconds * 1000);
  }
  fail(`build did not finish within ${opts.timeoutSeconds}s`);
}

async function waitForDeployment(projectId, serviceId) {
  step('Waiting for the deployment to run');
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let last;
  while (Date.now() < deadline) {
    let status = 'UNKNOWN';
    try {
      const list = await nf('GET', `/v1/projects/${projectId}/services/${serviceId}/deployments`);
      const deployments = firstArray(list?.data?.deployments);
      const active = deployments.find((d) => d.active) ?? deployments[0];
      status = active?.status ?? 'UNKNOWN';
    } catch {
      status = deepFindStatus(await nf('GET', `/v1/projects/${projectId}/services/${serviceId}`)) ?? 'UNKNOWN';
    }
    if (status !== last) {
      log(`  ..  deployment status: ${status}`);
      last = status;
    }
    if (DEPLOY_OK.includes(status)) return true;
    if (DEPLOY_BAD.includes(status)) return false;
    await sleep(opts.pollSeconds * 1000);
  }
  log('  ..  status unknown before the timeout; run `status` and `logs`');
  return false;
}

// ---------------------------------------------------------------------------
// Backend verification — the same endpoints the worker itself uses
// ---------------------------------------------------------------------------

function sessionsOf(body) {
  if (Array.isArray(body?.sessions)) return body.sessions;
  if (Array.isArray(body?.data?.sessions)) return body.data.sessions;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

async function checkApi() {
  step('Verifying the Zora worker endpoints');
  if (!opts.apiBase) fail('--api-base is required (the deployed Zora app URL)');
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!secret) fail('WORKER_SHARED_SECRET is not set in this workspace environment');

  let ok = true;
  const unauth = await fetch(`${opts.apiBase}/api/public/worker/poll`);
  if (unauth.status === 401) {
    log('  ok  unauthenticated poll is rejected (401)');
  } else {
    ok = false;
    log(`  FAIL unauthenticated poll returned ${unauth.status} instead of 401`);
  }

  const res = await fetch(`${opts.apiBase}/api/public/worker/poll`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) {
    fail(`authenticated poll failed with ${res.status}. Is WORKER_SHARED_SECRET the same value the app uses?`);
  }
  const sessions = sessionsOf(await res.json());
  log(`  ok  worker poll accepted (${res.status})`);
  log(`  ok  sessions visible to the worker: ${sessions.length}`);
  for (const s of sessions) {
    // Never print access tokens; only the routing state the worker acts on.
    log(
      `       - user ${s.discord_user_id ?? '?'} desired=${s.desired_state ?? '?'} ` +
        `revision=${s.revision ?? '?'} token=${s.access_token ? 'present' : 'missing'}`,
    );
  }
  if (!sessions.length) log('       (no account linked yet — open the Zora app and connect Discord)');
  return ok;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Northflank builds whatever branch the service points at. If the Dockerfile is
 * not there, the build fails *after* the project and service already exist,
 * wasting build minutes and leaving a half-configured service behind. Check the
 * public raw URL first so a missing Dockerfile costs nothing.
 */
async function checkBranchDockerfile() {
  step(`Checking branch "${opts.branch}" for the worker Dockerfile`);
  const slug = opts.repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  const url = `https://raw.githubusercontent.com/${slug}/${opts.branch}/worker/Dockerfile`;
  let res;
  try {
    res = await fetch(url, { method: 'HEAD' });
  } catch (e) {
    log(`  --  check skipped (${e.message})`);
    return true;
  }
  if (res.ok) {
    log('  ok  worker/Dockerfile is present on that branch');
    return true;
  }
  log(`  FAIL worker/Dockerfile not found on "${opts.branch}" (HTTP ${res.status})`);
  log('       Northflank builds this branch, so its build would stop at "Dockerfile not found".');
  log('       Merge the deploy commit into that branch, or pass --branch <branch that has it>.');
  log('       (A 404 here can also mean the repository is not publicly readable.)');
  return false;
}

async function up() {
  requireToken();
  if (!(await checkBranchDockerfile())) {
    step('Result');
    console.error(
      '  Refusing to proceed: the branch Northflank would build has no Dockerfile,\n' +
        '  so no project or service was created.',
    );
    process.exit(1);
  }
  const projectId = await ensureProject();
  const serviceId = await ensureService(projectId);
  const buildId = await startBuild(projectId, serviceId);
  if (!(await waitForBuild(projectId, serviceId, buildId))) {
    step('Result');
    console.error('  Build failed. The log tail above is the exact build output.');
    process.exit(1);
  }
  const deployed = await waitForDeployment(projectId, serviceId);

  step('Recent worker logs');
  try {
    for (const line of await runtimeLogs(projectId, serviceId)) log(`  ${line}`);
  } catch (e) {
    log(`  (logs unavailable: ${e.message})`);
  }

  await checkApi();

  step('Result');
  log(`  service:   ${opts.service} in project ${projectId}`);
  log(`  deployment: ${deployed ? 'running' : 'not confirmed yet'}`);
  log(`  console:   https://app.northflank.com/s/project/${projectId}/service/${serviceId}`);
  log('  Next: open the Zora app, connect Discord and start presence — the worker');
  log('  picks the session up on its next poll (about 5 seconds).');
}

async function status() {
  requireToken();
  const projectId = await ensureProject({ create: false });
  const service = await findService(projectId);
  if (!service) fail(`service "${opts.service}" does not exist in project ${projectId}`);
  step(`Service ${service.id}`);
  const info = await nf('GET', `/v1/projects/${projectId}/services/${service.id}`);
  const data = info?.data ?? {};
  log(`  status:     ${deepFindStatus(info) ?? 'unknown'}`);
  log(`  repository: ${data.vcsData?.projectUrl ?? opts.repo} (${data.vcsData?.projectBranch ?? opts.branch})`);
  const args = await nf('GET', `/v1/projects/${projectId}/services/${service.id}/build-arguments`);
  log(`  build args: ${Object.keys(args?.data?.buildArguments ?? {}).join(', ') || 'none'}`);
  const env = await nf('GET', `/v1/projects/${projectId}/services/${service.id}/runtime-environment`);
  log(`  env vars:   ${Object.keys(env?.data?.runtimeEnvironment ?? {}).join(', ') || 'none'} (values withheld)`);
  try {
    const list = await nf('GET', `/v1/projects/${projectId}/services/${service.id}/deployments`);
    for (const d of firstArray(list?.data?.deployments).slice(0, 3)) {
      log(`  deployment: ${d.id} status=${d.status} active=${d.active} created=${d.createdAt}`);
    }
  } catch {
    /* deployment history is optional */
  }
}

async function logs() {
  requireToken();
  const projectId = await ensureProject({ create: false });
  const service = await findService(projectId);
  if (!service) fail(`service "${opts.service}" does not exist in project ${projectId}`);
  step('Runtime logs');
  // While the first build is still running there is no deployment yet, and the
  // logs endpoint 404s. That must not hide the build logs below.
  try {
    for (const line of await runtimeLogs(projectId, service.id)) log(`  ${line}`);
  } catch (e) {
    log(`  (no runtime logs yet: ${e.message})`);
  }
  step('Build logs');
  for (const line of (await buildLogs(projectId, service.id)).slice(-opts.limit)) log(`  ${line}`);
}

async function build() {
  requireToken();
  const projectId = await ensureProject();
  const serviceId = await ensureService(projectId);
  const buildId = await startBuild(projectId, serviceId);
  const built = await waitForBuild(projectId, serviceId, buildId);
  await waitForDeployment(projectId, serviceId);
  process.exit(built ? 0 : 1);
}

function help() {
  log(`Zora presence worker -> Northflank

  node worker/deploy/northflank/deploy.mjs <command> [flags]

Commands
  dry-run     Validate every payload against Northflank's live API spec (no token)
  up          Create/converge the service, build, deploy, verify the backend
  build       Trigger a build and wait for it
  status      Show service configuration and deployment status
  logs        Print runtime and build logs
  check-api   Verify the Zora worker endpoints with the shared secret

Flags
  --api-base <url>         deployed Zora app URL (required by up/check-api)
  --sdk-url <url>          link to DiscordSocialSdk-*.zip (required by up/build)
  --sdk-sha256 <hash>      optional integrity check for the archive
  --project <name>         Northflank project (default: zora)
  --service <name>         service name (default: zora-presence-worker)
  --repo <url>             git repository (default: Z480-fly/rich-status-studio)
  --branch <name>          branch to build (default: main)
  --sha <commit>           commit to build (combined services require a sha; auto-resolved if omitted)
  --region <id>            region for a newly created project (default: europe-west)
  --deployment-plan <id>   override the auto-selected deployment plan
  --build-plan <id>        override the auto-selected build plan
  --discord-app-id <id>    passed to the worker as DISCORD_APP_ID
  --ci                     also rebuild on every push to the branch
  --limit <n>              log lines to print (default: 120)

Environment (read, never written to the repository)
  NORTHFLANK_API_TOKEN, WORKER_SHARED_SECRET, DISCORD_APP_ID, ZORA_API_BASE
`);
}

const commands = { 'dry-run': dryRun, up, build, status, logs, 'check-api': checkApi, help };
const run = commands[command];
if (!run) fail(`unknown command "${command}" — run with --help`);
await run();
