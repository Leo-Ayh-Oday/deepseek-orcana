/** Win32 Job Object wrapper — process tree isolation via kernel32.
 *
 *  Job Objects guarantee: when the parent process is killed, all child
 *  processes in the same Job Object are terminated atomically by the OS.
 *  This is the strongest Windows isolation primitive available without
 *  admin rights.
 *
 *  Graceful degradation: if bun:ffi is unavailable or not on Windows,
 *  returns a no-op wrapper that does nothing (macOS/Linux/Node.js).
 */

let createJobObj: (name?: string) => object | null
let setJobLimits: (job: object, opts: { memoryMb?: number; cpuPercent?: number; timeSec?: number }) => boolean
let assignProcToJob: (job: object, pid: number) => boolean
let terminateJob: (job: object) => boolean
let closeJob: (job: object) => void

function buildNoOp() {
  createJobObj = () => null
  setJobLimits = () => false
  assignProcToJob = () => false
  terminateJob = () => false
  closeJob = () => {}
}

try {
  // bun:ffi is only available in Bun runtime
  const { dlopen, FFIType } = require("bun:ffi") as {
    dlopen: (name: string, symbols: Record<string, unknown>) => { symbols: Record<string, unknown> }
    FFIType: { pointer: unknown; i32: unknown; u32: unknown; bool: unknown; cstring: unknown }
  }

  const kernel32 = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.pointer },
    SetInformationJobObject: { args: [FFIType.pointer, FFIType.i32, FFIType.pointer, FFIType.u32], returns: FFIType.bool },
    AssignProcessToJobObject: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.bool },
    TerminateJobObject: { args: [FFIType.pointer, FFIType.u32], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.pointer], returns: FFIType.bool },
    GetCurrentProcess: { args: [], returns: FFIType.pointer },
  })

  // ── Wide string helper: CreateJobObjectW expects UTF-16LE ──
  function wideStringPtr(s: string): Buffer {
    const buf = Buffer.alloc((s.length + 1) * 2)
    for (let i = 0; i < s.length; i++) buf.writeUInt16LE(s.charCodeAt(i), i * 2)
    return buf  // last 2 bytes stay 0 (null terminator)
  }

  // ── JOBOBJECT_EXTENDED_LIMIT_INFORMATION layout (x64, Windows 10/11) ──
  // Verified against winnt.h: BasicLimitInformation (64) + IoInfo (48) +
  // ProcessMemoryLimit (8) + JobMemoryLimit (8) + PeakProcessMemoryUsed (8) +
  // PeakJobMemoryUsed (8) = 144 bytes.
  //
  // WARNING: ARM64 Windows may differ. If running on ARM64, this module
  // degrades to no-op (bun:ffi won't find kernel32 symbols in the same way).
  const JobObjectExtendedLimitInformation = 9
  const JOB_LIMIT_FLAGS_OFFSET = 16  // within JOBOBJECT_BASIC_LIMIT_INFORMATION
  const JOB_MEMORY_LIMIT_OFFSET = 120 // after BasicLimitInfo(64)+IoInfo(48)+ProcessMemoryLimit(8)
  const SIZEOF_EXTENDED_LIMITS = 144

  // LimitFlags bits
  const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000

  createJobObj = (name?: string): object | null => {
    const nameBuf = name ? wideStringPtr(name) : null
    const ptr = (kernel32.symbols.CreateJobObjectW as (securityAttrs: number, namePtr: Buffer | number) => number)(0, nameBuf ?? 0)
    return ptr ? { handle: ptr } : null
  }

  setJobLimits = (job: object, opts: { memoryMb?: number; cpuPercent?: number; timeSec?: number }): boolean => {
    const h = (job as { handle: number }).handle
    if (!h) return false

    const buf = Buffer.alloc(SIZEOF_EXTENDED_LIMITS)
    buf.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_LIMIT_FLAGS_OFFSET)

    if (opts.memoryMb) {
      const bytes = BigInt(opts.memoryMb) * 1024n * 1024n
      buf.writeBigUInt64LE(bytes, JOB_MEMORY_LIMIT_OFFSET)
    }

    return (kernel32.symbols.SetInformationJobObject as (h: number, infoClass: number, buf: Buffer, len: number) => boolean)(
      h, JobObjectExtendedLimitInformation, buf, buf.length
    ) === true
  }

  assignProcToJob = (job: object, pid: number): boolean => {
    const h = (job as { handle: number }).handle
    if (!h) return false
    // On Windows we need the process handle, not PID.
    // Use OpenProcess to get handle from PID.
    const { symbols } = (() => {
      return dlopen("kernel32.dll", {
        OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.pointer },
      })
    })()
    const PROCESS_SET_QUOTA = 0x0100
    const PROCESS_TERMINATE = 0x0001
    const ph = (symbols.OpenProcess as (access: number, inherit: boolean, pid: number) => number)(
      PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid
    )
    if (!ph) return false
    const r = (kernel32.symbols.AssignProcessToJobObject as (job: number, proc: number) => boolean)(h, ph) === true
    ;(kernel32.symbols.CloseHandle as (h: number) => boolean)(ph)
    return r
  }

  terminateJob = (job: object): boolean => {
    const h = (job as { handle: number }).handle
    if (!h) return false
    return (kernel32.symbols.TerminateJobObject as (h: number, exitCode: number) => boolean)(h, 1) === true
  }

  closeJob = (job: object) => {
    const h = (job as { handle: number }).handle
    if (h) (kernel32.symbols.CloseHandle as (h: number) => boolean)(h)
  }
} catch {
  // Not running in Bun, not on Windows, or FFI unavailable
  buildNoOp()
}

export interface JobObject {
  handle: number
}

export function createJob(name?: string): JobObject | null {
  return createJobObj(name) as JobObject | null
}

export function setLimits(job: JobObject, opts: { memoryMb?: number; cpuPercent?: number; timeSec?: number }): boolean {
  return setJobLimits(job, opts)
}

export function assignProcess(job: JobObject, pid: number): boolean {
  return assignProcToJob(job, pid)
}

export function killJob(job: JobObject): boolean {
  return terminateJob(job)
}

export function disposeJob(job: JobObject): void {
  closeJob(job)
}
