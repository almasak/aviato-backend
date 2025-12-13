export default { async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);
		// @ts-expect-error
		if (!env.GITHUB_TOKEN) {
		  console.error("Missing GITHUB_TOKEN");
		}

		// POST /task -> Create a new task
		if(req.method === 'POST' && url.pathname === '/task') {
			const taskId = crypto.randomUUID();

			// 1. store fast task status in the kv
			// @ts-expect-error
			await env.TASKS_KV.put(`task:${taskId}`, JSON.stringify({
    			status: 'pending',
    			updatedAt: new Date().toISOString()
  			}));

			// 2. store record in D1
			// @ts-expect-error
			await env.flights_db
				.prepare(`INSERT INTO tasks (id, status, created_at) VALUES (?, ?, ?)`)
				.bind(taskId, 'pending', new Date().toISOString())
				.run();

			// 3. trigger github actions for background processing
			console.log("Dispatching to GitHub for task:", taskId);
			ctx.waitUntil(
			  fetch("https://api.github.com/repos/almasak/aviato-backend/dispatches", {
			    method: "POST",
			    headers: {
				//@ts-expect-error
			      "Authorization": `token ${env.GITHUB_TOKEN}`,
			      "Accept": "application/vnd.github+json",
			      "Content-Type": "application/json",
			      "User-Agent": "cf-worker"
			    },
			    body: JSON.stringify({
			      event_type: "process-task",
			      client_payload: { taskId }
			    })
			  }).then(async (res) => {
			    console.log("GitHub dispatch status:", res.status);
			    console.log("GitHub dispatch response:", await res.text());
			  })
			);
			// 4. return payload
			return Response.json({ taskId });
		}

		// GET /task/:id -> check task status
		if(req.method === `GET` && url.pathname.startsWith('/task/')) {
			const taskId = url.pathname.split('/')[2];

			// 1. first, check KV for fast status
			// @ts-expect-error
			const kvValue = await env.TASKS_KV.get<{
  				status: string;
  				updatedAt: string;
			}>(`task:${taskId}`, 'json');

			if(!kvValue || !kvValue.status) {
				return new Response('Task not found', { status: 404 });
			}

			// 2. fetch record from D1
			// @ts-expect-error
			const task = await env.flights_db
				.prepare(`SELECT * FROM tasks WHERE id = ?`)
				.bind(taskId)
				.first();

			return Response.json(task);
		}

		return new Response("Not Found", { status: 404 });
	},
};
