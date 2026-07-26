import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...nextVitals,
  { ignores: [".next/**", "node_modules/**", "vendor/**", "playwright-report/**", "test-results/**"] }
];

export default config;
