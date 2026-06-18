import { Hono } from "hono"

// ── In-memory storage ─────────────────────────────────────────────
interface Todo {
  id: string
  title: string
  completed: boolean
}

const todos: Todo[] = []

// ── Helpers ───────────────────────────────────────────────────────
function findTodo(id: string): [Todo | undefined, number] {
  const idx = todos.findIndex((t) => t.id === id)
  return [todos[idx], idx]
}

// ── App ───────────────────────────────────────────────────────────
const app = new Hono()

app.get("/", (c) => c.text("Todo API"))

// GET /health — liveness/readiness
app.get("/health", (c) => c.json({ status: "ok" }))

// POST /todos — create
app.post("/todos", async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  if (typeof body !== "object" || body === null) {
    return c.json({ error: "Body must be a JSON object" }, 400)
  }

  const { title, completed } = body as Record<string, unknown>

  if (typeof title !== "string" || title.trim().length === 0) {
    return c.json({ error: "title is required and must be a non-empty string" }, 400)
  }

  const todo: Todo = {
    id: crypto.randomUUID(),
    title: title.trim(),
    completed: typeof completed === "boolean" ? completed : false,
  }
  todos.push(todo)
  return c.json(todo, 201)
})

// GET /todos — list all
app.get("/todos", (c) => {
  return c.json(todos)
})

// GET /todos/:id — get one
app.get("/todos/:id", (c) => {
  const id = c.req.param("id")
  const [todo] = findTodo(id)
  if (!todo) {
    return c.json({ error: "Todo not found" }, 404)
  }
  return c.json(todo)
})

// PUT /todos/:id — update
app.put("/todos/:id", async (c) => {
  const id = c.req.param("id")
  const [todo] = findTodo(id)
  if (!todo) {
    return c.json({ error: "Todo not found" }, 404)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  if (typeof body !== "object" || body === null) {
    return c.json({ error: "Body must be a JSON object" }, 400)
  }

  const { title, completed } = body as Record<string, unknown>

  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) {
      return c.json({ error: "title must be a non-empty string" }, 400)
    }
    todo.title = title.trim()
  }

  if (completed !== undefined) {
    if (typeof completed !== "boolean") {
      return c.json({ error: "completed must be a boolean" }, 400)
    }
    todo.completed = completed
  }

  return c.json(todo)
})

// DELETE /todos/:id — delete
app.delete("/todos/:id", (c) => {
  const id = c.req.param("id")
  const [, idx] = findTodo(id)
  if (idx === -1) {
    return c.json({ error: "Todo not found" }, 404)
  }
  todos.splice(idx, 1)
  return c.body(null, 204)
})

export { app }
export default { port: 3000, fetch: app.fetch }
