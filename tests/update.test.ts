import { describe, expect, it } from 'vitest'
import { isNewer, parseLatest, UPDATE_ORIGIN } from '../src/shared/update'

describe('isNewer', () => {
  it('compares numerically, not as text', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true)
    expect(isNewer('0.2.0', '0.1.99')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
  })
  it('is false for the same or an older version', () => {
    expect(isNewer('0.1.3', '0.1.3')).toBe(false)
    expect(isNewer('0.1.2', '0.1.3')).toBe(false)
  })
  it('is false for anything that is not x.y.z', () => {
    expect(isNewer('', '0.1.3')).toBe(false)
    expect(isNewer('0.1', '0.1.3')).toBe(false)
    expect(isNewer('9.9.9-beta', '0.1.3')).toBe(false)
  })
})

describe('parseLatest', () => {
  const body = {
    version: '0.1.4',
    windows: `${UPDATE_ORIGIN}/v0.1.4/Anonymo-Setup-0.1.4.exe`,
    mac: `${UPDATE_ORIGIN}/v0.1.4/Anonymo-0.1.4-arm64.dmg`
  }

  it('offers the installer for this platform when the version is newer', () => {
    expect(parseLatest(body, '0.1.3', 'win32')).toEqual({ version: '0.1.4', url: body.windows, mode: 'download' })
    expect(parseLatest(body, '0.1.3', 'darwin')).toEqual({ version: '0.1.4', url: body.mac, mode: 'download' })
  })
  it('offers nothing when up to date, or on a platform without an installer', () => {
    expect(parseLatest(body, '0.1.4', 'win32')).toBeNull()
    expect(parseLatest(body, '0.1.3', 'linux')).toBeNull()
  })
  it('never offers a link outside the download server', () => {
    expect(parseLatest({ ...body, windows: 'https://evil.example/x.exe' }, '0.1.3', 'win32')).toBeNull()
    expect(parseLatest({ ...body, windows: `${UPDATE_ORIGIN}.evil.example/x.exe` }, '0.1.3', 'win32')).toBeNull()
  })
  it('ignores malformed responses', () => {
    expect(parseLatest(null, '0.1.3', 'win32')).toBeNull()
    expect(parseLatest('0.1.4', '0.1.3', 'win32')).toBeNull()
    expect(parseLatest({ version: 4 }, '0.1.3', 'win32')).toBeNull()
  })
})
