import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { basePathOf, deviceAuthHeaders, setApiBaseUrlOverride } from '../apiService';

const mockSignDeviceRequest = jest.fn<(method: string, path: string, deviceId: string) => Promise<{ timestamp: string; signature: string } | null>>();

jest.mock('../deviceIdentity', () => ({
  getDeviceId: async () => 'and-test-device',
  signDeviceRequest: (method: string, path: string, deviceId: string) => mockSignDeviceRequest(method, path, deviceId),
}));
jest.mock('../storage', () => ({
  prefs: { get: async () => null, set: async () => undefined, remove: async () => undefined },
  secrets: { get: async () => null, set: async () => undefined, remove: async () => undefined },
}));

describe('basePathOf', () => {
  it.each([
    ['https://api.baranguardph.win/api/v1', '/api/v1'],
    ['https://api.baranguardph.win/api/v1/', '/api/v1'],
    ['http://192.168.1.10:8081/api/v1', '/api/v1'],
    ['http://localhost:8081/baranguard-api/api/v1', '/baranguard-api/api/v1'],
    ['http://localhost:8081', ''],
    ['http://host/api/v1?x=1#y', '/api/v1'],
  ])('%s -> %s', (url, expected) => {
    expect(basePathOf(url)).toBe(expected);
  });
});

describe('deviceAuthHeaders (H-09)', () => {
  beforeEach(() => {
    mockSignDeviceRequest.mockReset();
  });

  // The server verifies against the full REQUEST_URI it saw; signing the
  // bare route path would make it reject every signature.
  it('signs the full request path including the base URL mount prefix', async () => {
    await setApiBaseUrlOverride('http://192.168.1.10:8081/api/v1');
    mockSignDeviceRequest.mockResolvedValue({ timestamp: '1700000000', signature: 'c2ln' });

    const headers = await deviceAuthHeaders('POST', '/gps', 'and-test-device');

    expect(mockSignDeviceRequest).toHaveBeenCalledWith('POST', '/api/v1/gps', 'and-test-device');
    expect(headers).toEqual({
      'X-Device-Id': 'and-test-device',
      'X-Device-Timestamp': '1700000000',
      'X-Device-Signature': 'c2ln',
    });
  });

  it('degrades to X-Device-Id alone when signing is unavailable', async () => {
    mockSignDeviceRequest.mockResolvedValue(null);
    expect(await deviceAuthHeaders('POST', '/tanod-sos', 'and-test-device')).toEqual({ 'X-Device-Id': 'and-test-device' });
  });
});
