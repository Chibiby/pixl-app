import { app, nativeImage } from 'electron'
import { join } from 'path'

// Resolve the app icon in both dev (project build/ folder) and packaged builds
// (copied into resources/ via electron-builder extraResources).
export function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

/** Branded icon as a NativeImage, or an empty image if the file is missing. */
export function appIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(iconPath())
}
