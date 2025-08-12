# WordPress Plugin Testing Environment

Local WordPress development environment for testing the AI SMB Booker plugin.

## Prerequisites

### Docker Installation
- **Windows/Mac**: Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Linux**: Install Docker Engine and Docker Compose
- **WSL2 (Windows)**: Enable WSL integration in Docker Desktop settings

### Verify Installation
```bash
docker --version
docker compose --version  # Note: newer syntax without hyphen
```

### WSL2 Fix (if needed)
If you get `docker-compose command not found` or commands hang in WSL2:

**Option 1: Use Windows Docker directly (faster) - RECOMMENDED for WSL2**
```bash
# Add permanent aliases to your shell profile (one-time setup)
echo 'alias docker="/mnt/c/Program\ Files/Docker/Docker/resources/bin/docker.exe"' >> ~/.bashrc
echo 'alias docker-compose="/mnt/c/Program\ Files/Docker/Docker/resources/bin/docker-compose.exe"' >> ~/.bashrc

# Reload your shell or run manually for current session:
source ~/.bashrc
```

**Option 2: Fix WSL integration**
1. Open Docker Desktop
2. Go to Settings → Resources → WSL Integration  
3. Enable integration with your WSL2 distro
4. Restart WSL2: `wsl --shutdown` then reopen terminal

## Quick Start

1. **Generate the WordPress plugin first:**
   ```bash
   # From project root
   pnpm generate:adapter --manifest platforms/wordpress.manifest.yaml
   ```

2. **Start WordPress testing environment:**
   ```bash
   # From this directory (use Windows Docker if WSL2 is slow)
   docker-compose -f docker-compose.test.yml up -d
   
   # Or with Windows Docker directly:
   /mnt/c/Program\ Files/Docker/Docker/resources/bin/docker-compose.exe -f docker-compose.test.yml up -d
   ```

3. **Access WordPress:**
   - WordPress: http://localhost:8080
   - PHPMyAdmin: http://localhost:8081 (optional database admin)

4. **WordPress Setup:**
   - Complete the WordPress installation wizard
   - Login to admin at http://localhost:8080/wp-admin
   - Navigate to Plugins → Installed Plugins
   - Activate "AI SMB Booker" plugin
   - Configure the plugin in Settings → AI SMB Booker

## Development Workflow

### Plugin Updates
After making changes to plugin templates in `tools/adapter-gen/templates/wordpress/`:
```bash
# Regenerate plugin
pnpm generate:adapter --manifest platforms/wordpress.manifest.yaml

# Plugin files are automatically updated via volume mount
# Refresh your WordPress admin to see changes
```

### Logs and Debugging
```bash
# View WordPress logs
docker compose -f docker-compose.test.yml logs wordpress

# View all logs
docker compose -f docker-compose.test.yml logs

# WordPress debug.log location inside container:
# /var/www/html/wp-content/debug.log
```

### Database Management
- **PHPMyAdmin**: http://localhost:8081
  - Username: `root`
  - Password: `rootpassword`
- **Database**: `wordpress`
- **WordPress DB User**: `wordpress` / `wordpress`

## Day-to-Day Usage

### Starting WordPress Environment (after initial setup)
```bash
# Navigate to directory
cd platforms/wordpress-plugin

# Start containers (if stopped)
docker-compose -f docker-compose.test.yml up -d

# Check status
docker-compose -f docker-compose.test.yml ps

# Access:
# - WordPress: http://localhost:8080
# - PHPMyAdmin: http://localhost:8081
```

### Stopping Environment
```bash
# Stop containers (keeps data)
docker-compose -f docker-compose.test.yml stop

# Stop and remove containers (keeps data)
docker-compose -f docker-compose.test.yml down
```

## Cleanup
```bash
# Stop containers
docker compose -f docker-compose.test.yml down

# Remove containers and volumes (fresh start)
docker compose -f docker-compose.test.yml down -v

# Remove images (free up space)
docker compose -f docker-compose.test.yml down --rmi all
```

## Plugin Testing Checklist

- [ ] Plugin activates without errors
- [ ] Settings page appears under Settings → AI SMB Booker  
- [ ] JSON-LD script injection works on frontend
- [ ] Widget loader script is present
- [ ] OAuth flow works for Google/Microsoft calendars
- [ ] No PHP errors in debug.log
- [ ] Plugin deactivates cleanly

## Corporate Network Issues

**Zscaler/Corporate Proxy Users:**
- Disable Zscaler during initial Docker image downloads
- Can re-enable after containers are running
- Network timeouts during `docker pull` are normal with corporate proxies

## Troubleshooting

### Plugin Not Found
- Ensure `pnpm generate:adapter` was run successfully
- Check that `platforms_out/wordpress-plugin/` contains plugin files
- Verify volume mount path in docker-compose.test.yml

### Permission Issues
```bash
# Fix file permissions if needed
sudo chown -R $USER:$USER ./wp-content
```

### Database Connection Issues
- Ensure MySQL container is healthy: `docker compose ps`
- Check MySQL logs: `docker compose logs db`