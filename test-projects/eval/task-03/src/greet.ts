export function greet(name: string): string {
  if (!name) return "Hello, World!"
  return `Hello, ${name}!`
}

export function greetAll(names: string[]): string {
  return names.map(n => greet(n)).join("\n")
}
