// types
type TaskStatus = "pending" | "running" | "completed" | "failed";

interface InternalTaskPayload {
  taskId: string;
  result?: unknown;
  error?: string;
}

export interface Env {
	flights_db: D1Database;
	TASKS_KV: KVNamespace;
	GITHUB_TOKEN: string;
	INTERNAL_SECRET: string;
}

// state machine for task processing
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	'pending': ['running'],
	'running': ['completed', 'failed'],
	'completed': [],
	'failed': []
};

function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	return ALLOWED_TRANSITIONS[from].includes(to);
}

// Worker entry point
export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);

		// public APIs
		// POST /task -> Create a new task
		if(req.method === 'POST' && url.pathname === '/task') {
			return createTask(env, ctx);
		}

		// GET /task/:taskId -> check task status
		if(req.method === 'GET' && url.pathname.startsWith('/task/')) {
			const taskId = url.pathname.split('/')[2];
			return getTask(env, taskId);
		}

		// internal APIs
		if(url.pathname.startsWith('/internal/')) {
			return handleInternal(env, req);
		}

		return new Response('Not Found', { status: 404 });
	},
};

// create a new task
async function createTask(env: Env, ctx: ExecutionContext): Promise<Response> {
	const taskId = crypto.randomUUID();
	const now = new Date().toISOString();

	await env.TASKS_KV.put(`task:${taskId}`, "pending");

	await env.flights_db
		.prepare(
      		`INSERT INTO tasks (id, status, created_at, updated_at)
      		 VALUES (?, ?, ?, ?)`
    	)
    	.bind(taskId, "pending", now, now)
    	.run();

		console.log("Dispatching GitHub workflow for task:", taskId);
		ctx.waitUntil(
    	fetch("https://api.github.com/repos/almasak/aviato-backend/dispatches", {
    		method: "POST",
    	  	headers: {
    	    	Authorization: `token ${env.GITHUB_TOKEN}`,
    	    	Accept: "application/vnd.github+json",
    	    	"Content-Type": "application/json",
    	    	"User-Agent": "cf-worker",
    	  	},
    	  	body: JSON.stringify({
    	    	event_type: "process-task",
    	    	client_payload: { taskId },
    	  	}),
    	}).then(async (res) => {
    		console.log("GitHub dispatch status:", res.status);
    	  	if (res.status !== 204) {
    	    	console.error(await res.text());
    	  	}
     	})
  	);
  	return Response.json({ taskId }, { status: 202 });
}

// get task status
async function getTask(env: Env, taskId: string): Promise<Response> {
	const status = await env.TASKS_KV.get(`task:${taskId}`);
	if(!status) {
		return new Response("Not found", { status: 404 });
	}

	const task = await env.flights_db
		.prepare(
			'SELECT * FROM tasks WHERE id = ?'
		)
		.bind(taskId)
		.first();

	return Response.json(task);
}

// internal router
async function handleInternal(env: Env, req: Request): Promise<Response> {
	if (req.headers.get("x-internal-secret") !== env.INTERNAL_SECRET) {
		return new Response('Forbidden', { status: 403 });
	}

	let body: InternalTaskPayload;
	try {
		body = await req.json();
	} catch {
		return new Response('Bad Request', { status: 400 });
	}

	const path = new URL(req.url).pathname;

	if(path === '/internal/task/start') {
		return transitionTask(body.taskId, "running", null, env);
	}

	if(path === '/internal/task/complete') {
		return transitionTask(body.taskId, "completed", JSON.stringify(body.result ?? null), env);
	}

	if(path === '/internal/task/fail') {
		return transitionTask(body.taskId, "failed", body.error ?? "Unknown error", env);
	}

	return new Response('Not Found', { status: 404 });
}

// transition handler -> single source of truth for state transactions
async function transitionTask(
	taskId: string,
	targetStatus: TaskStatus,
	result: string | null,
	env: Env,
): Promise<Response> {
	const task = await env.flights_db
		.prepare(
			'SELECT * FROM tasks WHERE id = ?'
		)
		.bind(taskId)
		.first<{status: TaskStatus}>();

	if(!task) {
		return new Response("Not found", { status: 404 });
	}

	// idempotent retries
	if(task.status === targetStatus) {
		return new Response("OK", { status: 200 });
	}

	// enforce the state machine
	if(!canTransition(task.status, targetStatus)) {
		return new Response("Invalid state transition", { status: 400 });
	}

	const now = new Date().toISOString();

	// update KV for fast polling
	await env.TASKS_KV.put(`task:${taskId}`, targetStatus);

	// update D1 for persistence
	await env.flights_db
		.prepare(
			`UPDATE tasks
			 SET status = ?, result = ?, updated_at = ?
			 WHERE id = ?`
		)
		.bind(targetStatus, result, now, taskId)
		.run();

	return new Response("OK", { status: 200 });

}
