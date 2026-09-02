import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Testcontainers looks for /var/run/docker.sock by default. On setups like
// OrbStack/Colima the socket lives elsewhere; derive DOCKER_HOST from the
// active docker context so `npm test` works without manual configuration.
if (!process.env.DOCKER_HOST && !existsSync('/var/run/docker.sock')) {
  try {
    const endpoint = execSync('docker context inspect -f "{{.Endpoints.docker.Host}}"', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (endpoint) process.env.DOCKER_HOST = endpoint;
  } catch {
    // Leave unset; testcontainers will surface a clear error if Docker is down.
  }
}
