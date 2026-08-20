import { tool } from '@swiftagent/sdk';
import { z } from 'zod';

// Fixed hosts only — the keyless Open-Meteo API. No visitor-controlled URLs.
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Minimal fetch shape so tests can inject a fake without pulling in DOM types. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const GeocodeResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().optional(),
      }),
    )
    .optional(),
});

const ForecastResponseSchema = z.object({
  current: z.object({
    temperature_2m: z.number(),
    wind_speed_10m: z.number(),
    weather_code: z.number(),
  }),
});

/**
 * Current conditions for a named city via the keyless Open-Meteo API: a real
 * geocode + forecast network round trip, so the measured duration on the demo
 * page means something. `fetchImpl` is injectable for hermetic unit tests.
 */
export function createGetWeatherTool(
  fetchImpl: FetchLike = (url) => fetch(url),
) {
  return tool({
    name: 'get_weather',
    description:
      'Get current weather conditions (temperature, wind, weather code) for a named city.',
    inputSchema: z.object({
      city: z.string().min(1).max(100),
    }),
    execute: async ({ city }) => {
      const geoRes = await fetchImpl(
        `${GEOCODE_URL}?name=${encodeURIComponent(city)}&count=1`,
      );
      if (!geoRes.ok) {
        throw new Error(`Geocoding request failed with status ${geoRes.status}.`);
      }
      const geo = GeocodeResponseSchema.parse(await geoRes.json());
      const place = geo.results?.[0];
      if (!place) {
        throw new Error(`No location found for "${city}".`);
      }

      const forecastRes = await fetchImpl(
        `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
          '&current=temperature_2m,wind_speed_10m,weather_code',
      );
      if (!forecastRes.ok) {
        throw new Error(
          `Forecast request failed with status ${forecastRes.status}.`,
        );
      }
      const forecast = ForecastResponseSchema.parse(await forecastRes.json());

      return {
        city: place.name,
        country: place.country ?? null,
        temperatureC: forecast.current.temperature_2m,
        windSpeedKmh: forecast.current.wind_speed_10m,
        weatherCode: forecast.current.weather_code,
      };
    },
  });
}

export const getWeatherTool = createGetWeatherTool();
