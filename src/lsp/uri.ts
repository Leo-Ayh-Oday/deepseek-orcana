/** LSP URI helpers — file:// ↔ absolute path conversion.
 *
 *  LSP uses file:// URIs everywhere. These are minimal converters
 *  without external dependencies.
 */

export const URI = {
  /** Convert absolute path → file:// URI */
  file(absPath: string): string {
    const normalized = absPath.replace(/\\/g, "/")
    // Drive letter: C:/ → /C:/
    if (/^[A-Za-z]:/.test(normalized)) {
      return `file:///${normalized}`
    }
    return `file://${normalized}`
  },

  /** Convert file:// URI → absolute path */
  toPath(uri: string): string {
    let path = uri.replace(/^file:\/\/\//, "")  // file:///C:/... → C:/...
    path = path.replace(/^file:\/\//, "")       // file:///home/... → /home/...
    // URL-decode common characters
    path = decodeURIComponent(path)
    // Normalize slashes
    path = path.replace(/\//g, process.platform === "win32" ? "\\" : "/")
    return path
  },
}
