import { getMachineId } from '../machine'

// Resolve the machine id once and cache it so every module shares the same value
// without repeatedly shelling out to the registry.
let cached: string | null = null

export function getMachineIdCached(): string {
  if (!cached) cached = getMachineId()
  return cached
}
