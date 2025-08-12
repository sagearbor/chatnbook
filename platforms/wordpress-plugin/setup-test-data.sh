#!/bin/bash
# Setup script to populate WordPress with test pages for plugin testing
# Run this after WordPress containers are up and WordPress is installed

echo "Setting up test pages for AI SMB Booker plugin..."

# Wait for WordPress to be ready
echo "Waiting for WordPress database to be ready..."
sleep 10

# Import test pages via MySQL
docker-compose -f docker-compose.test.yml exec -T db mysql -u wordpress -pwordpress wordpress < seed-data.sql

if [ $? -eq 0 ]; then
    echo "✅ Test pages created successfully!"
    echo ""
    echo "Available test pages:"
    echo "- Home: http://localhost:8080/home"
    echo "- Plumbing: http://localhost:8080/plumbing" 
    echo "- HVAC: http://localhost:8080/hvac"
    echo "- Electrical: http://localhost:8080/electrical"
    echo "- Landscaping: http://localhost:8080/landscaping"
    echo "- Appliance Repair: http://localhost:8080/appliance-repair"
    echo "- House Cleaning: http://localhost:8080/cleaning"
    echo ""
    echo "Each page has JSON-LD scheduling metadata and widget integration points."
else
    echo "❌ Failed to import test data. Make sure WordPress is fully installed."
    echo "Try running: docker-compose -f docker-compose.test.yml logs wordpress"
fi