import { NextResponse } from 'next/server';

/**
 * The 409 an admin route answers when a write hit ADMIN_CONFIG_READONLY,
 * carrying the ConfigReadOnlyError message so the panel can show why
 * nothing was saved (#1249). Returns null for any other error, which the
 * route keeps reporting as a 500.
 *
 * By the error's name, not instanceof: the config manager on globalThis
 * comes from another bundle's copy of lib/admin/paths.ts (the
 * instrumentation creates it), whose ConfigReadOnlyError is a different
 * class, and a read-only refusal then answered 500.
 */
export function configReadOnlyResponse(error: unknown): NextResponse | null {
  if (!(error instanceof Error) || error.name !== 'ConfigReadOnlyError') return null;
  return NextResponse.json({ error: error.message }, { status: 409 });
}
