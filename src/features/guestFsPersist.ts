/**
 * Guest persistence (barrel). The former single module was split into three
 * cohesive layers; this file preserves the public API and import path:
 *
 *   guestDiskStore        — IndexedDB + File System Access substrate, bind prompt,
 *                           save-info bus, vm-dirty flag, guest RAM/VGA constants
 *   guestVmSnapshot       — full v86 save_state() blob (RAM + 9p + processes)
 *   guestWorkspaceOverlay — /root/workspace mirror written as guest-disk/workspace.json
 */
export {
  GUEST_RAM_BYTES,
  GUEST_VGA_BYTES,
  bindGuestDiskFolder,
  setGuestDiskBindPrompt,
  markGuestVmDirty,
  getLastGuestDiskSave,
  onGuestDiskSaved,
  type StoredEntry,
  type Snapshot,
  type GuestDiskSaveInfo
} from './guestDiskStore'

export {
  loadVmStateBuffer,
  saveVmStateNow,
  clearVmStateSnapshot,
  startGuestVmStatePersist,
  loadLastGuestDiskSaveMeta
} from './guestVmSnapshot'

export {
  restoreGuestWorkspace,
  persistGuestWorkspaceNow,
  persistGuestWorkspaceAfterBind,
  scheduleGuestWorkspacePersist,
  startGuestWorkspacePersist,
  clearGuestWorkspacePersist
} from './guestWorkspaceOverlay'
