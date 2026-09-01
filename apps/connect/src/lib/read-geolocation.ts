"use client";

// Shared client-side geolocation reader. A worker's punch/geofence check and the
// background location monitor both need a device fix to "always" come back with
// something usable instead of going silent on the first transient GPS hiccup
// (cold start indoors, a slow satellite lock, a one-off timeout). This layers
// three attempts before giving up:
//   1. High-accuracy GPS with a short cache window.
//   2. Network/low-accuracy fix with a longer cache window (works indoors/on WiFi
//      when GPS satellites aren't visible).
//   3. The last fix this tab captured, if it is still recent enough to be useful.
// Only when all three fail (most commonly: location permission denied outright)
// does this reject — callers should treat that as "no location this attempt"
// rather than a fatal error.

const LAST_KNOWN_POSITION_MAX_AGE_MS = 10 * 60 * 1000;
let lastKnownPosition: GeolocationPosition | null = null;

function getCurrentPositionOnce(options: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not supported on this device."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (error) => {
      reject(new Error(error.message || "Unable to read device location. Allow location access."));
    }, options);
  });
}

export async function readResilientPosition(maximumAge = 30_000): Promise<GeolocationPosition> {
  try {
    const position = await getCurrentPositionOnce({ enableHighAccuracy: true, maximumAge, timeout: 20_000 });
    lastKnownPosition = position;
    return position;
  } catch (highAccuracyError) {
    try {
      const position = await getCurrentPositionOnce({
        enableHighAccuracy: false,
        maximumAge: Math.max(maximumAge, 5 * 60 * 1000),
        timeout: 15_000
      });
      lastKnownPosition = position;
      return position;
    } catch {
      if (lastKnownPosition && Date.now() - lastKnownPosition.timestamp <= LAST_KNOWN_POSITION_MAX_AGE_MS) {
        return lastKnownPosition;
      }
      throw highAccuracyError instanceof Error ? highAccuracyError : new Error("Unable to read device location.");
    }
  }
}
