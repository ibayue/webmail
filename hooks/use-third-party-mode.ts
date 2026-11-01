"use client";

import { useSyncExternalStore } from 'react';
import { noThirdPartyTraffic, subscribeThirdPartyMode } from '@/lib/third-party-mode';
import { usePolicyStore } from '@/stores/policy-store';

/**
 * Whether the browser must stay off built-in outside hosts (#903), as React
 * state: components re-render when the config arrives. True while the config
 * is still unknown, so nothing reaches out before it says it may.
 */
export function useNoThirdPartyTraffic(): boolean {
  return useSyncExternalStore(subscribeThirdPartyMode, noThirdPartyTraffic, () => true);
}

type PolicyState = ReturnType<typeof usePolicyStore.getState>;

/**
 * The external content setting locked to "block" by the organisation, or
 * limited to "block" as its only allowed value.
 */
function externalContentLockedToBlock(state: PolicyState): boolean {
  const restriction = state.getRestriction('externalContentPolicy');
  const allowed = restriction?.allowedValues;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes('allow') && !allowed.includes('ask')) return true;
  if (restriction?.locked !== true) return false;
  // A lock without a value locks the organisation's default (as the
  // settings store applies it).
  const value = Object.prototype.hasOwnProperty.call(restriction, 'value')
    ? restriction.value
    : state.getEffectiveDefault('externalContentPolicy');
  return value === 'block';
}

/**
 * Whether the organisation keeps remote content in mail from loading at all:
 * no third-party traffic, or the external content setting locked to "block".
 * Then neither a one-off load nor a trusted sender lets it through.
 */
export function useRemoteContentBlockedByOrg(): boolean {
  const noThirdParty = useNoThirdPartyTraffic();
  const lockedToBlock = usePolicyStore(externalContentLockedToBlock);
  return noThirdParty || lockedToBlock;
}

/** useRemoteContentBlockedByOrg, read once outside React. */
export function remoteContentBlockedByOrg(): boolean {
  return noThirdPartyTraffic() || externalContentLockedToBlock(usePolicyStore.getState());
}

// The first policy fetch hasn't answered yet (a later refetch keeps the
// policy it already has, so it doesn't count).
const policyPending = (state: PolicyState) => state.fetching && !state.loaded;

/**
 * Whether remote content stays blocked whatever the user chose: blocked by
 * the organisation, or the policy that may lock it hasn't loaded yet. Until
 * it has, neither a trusted sender nor a one-off load lets anything through,
 * so the first paint can't fire a tracker the organisation blocks.
 */
export function useRemoteContentHeldBack(): boolean {
  const blockedByOrg = useRemoteContentBlockedByOrg();
  const pending = usePolicyStore(policyPending);
  return blockedByOrg || pending;
}

/** useRemoteContentHeldBack, read once outside React. */
export function remoteContentHeldBack(): boolean {
  return remoteContentBlockedByOrg() || policyPending(usePolicyStore.getState());
}
