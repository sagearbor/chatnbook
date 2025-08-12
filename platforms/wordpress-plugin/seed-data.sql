-- WordPress test pages for AI SMB Booker plugin testing
-- Run this after WordPress setup to create sample business pages

-- Insert Home Page
INSERT INTO wp_posts (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES
(2, 1, NOW(), UTC_TIMESTAMP(), 
'<h1>Local Home Services - Book Instantly</h1>
<p><strong>Trusted professionals, instant booking, real-time availability</strong></p>
<p>Need a local service professional? Skip the phone calls and book directly online with verified local experts.</p>
<ul>
<li>✓ Emergency plumbing repairs</li>
<li>✓ HVAC maintenance &amp; repair</li>
<li>✓ Licensed electrical work</li>
<li>✓ Professional landscaping</li>
<li>✓ Appliance repair service</li>
<li>✓ House cleaning services</li>
</ul>
<p><strong>All services include:</strong></p>
<ul>
<li>Real-time availability</li>
<li>Instant booking confirmation</li>
<li>Licensed &amp; insured professionals</li>
<li>Transparent pricing</li>
<li>24/7 emergency options</li>
</ul>',
'Quick Connect Local Services', '', 'publish', 'closed', 'closed', '', 'home', '', '', NOW(), UTC_TIMESTAMP(), '', 0, '', 0, 'page', '', 0);

-- Insert Plumbing Page  
INSERT INTO wp_posts (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES
(3, 1, NOW(), UTC_TIMESTAMP(),
'<h1>Emergency Plumbing - Available 24/7</h1>
<p>Don''t let plumbing emergencies flood your day. Our licensed plumbers respond fast with professional repairs.</p>
<h2>Services We Provide:</h2>
<ul>
<li>Burst pipe emergency repairs</li>
<li>Water heater replacement &amp; repair</li>
<li>Drain cleaning &amp; unclogging</li>
<li>Toilet &amp; faucet repairs</li>
<li>Leak detection &amp; fixes</li>
<li>Sewer line cleaning</li>
</ul>
<h2>Emergency Response:</h2>
<ul>
<li>Available 24/7/365</li>
<li>Average response time: 45 minutes</li>
<li>Upfront pricing, no surprises</li>
<li>Licensed &amp; fully insured</li>
</ul>
<p><strong>Emergency Hotline: (404) 555-PIPE</strong></p>',
'24/7 Emergency Plumbing Services', 'Fast emergency plumbing repairs. Licensed plumbers available 24/7.', 'publish', 'closed', 'closed', '', 'plumbing', '', '', NOW(), UTC_TIMESTAMP(), '', 0, '', 0, 'page', '', 0);

-- Insert HVAC Page
INSERT INTO wp_posts (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES
(4, 1, NOW(), UTC_TIMESTAMP(),
'<h1>Professional HVAC Services</h1>
<p>Keep your home comfortable year-round with expert heating and cooling services from certified HVAC technicians.</p>
<h2>Our HVAC Services:</h2>
<ul>
<li>Air conditioning repair &amp; installation</li>
<li>Heating system maintenance &amp; repair</li>
<li>Duct cleaning &amp; sealing</li>
<li>Thermostat installation &amp; programming</li>
<li>Energy efficiency assessments</li>
<li>Emergency HVAC repairs</li>
</ul>
<h2>Brands We Service:</h2>
<p>Carrier, Trane, Lennox, Goodman, Rheem, York</p>
<p><strong>Call for Same-Day Service: (404) 555-HVAC</strong></p>',
'HVAC Repair & Installation - Heating & Cooling', 'Professional HVAC repair and installation. Same-day service.', 'publish', 'closed', 'closed', '', 'hvac', '', '', NOW(), UTC_TIMESTAMP(), '', 0, '', 0, 'page', '', 0);

-- Insert Electrical Page
INSERT INTO wp_posts (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES
(5, 1, NOW(), UTC_TIMESTAMP(),
'<h1>Licensed Electrical Services</h1>
<p>Safe, reliable electrical work by master electricians. From simple outlets to complete panel upgrades.</p>
<h2>Electrical Services:</h2>
<ul>
<li>Panel upgrades &amp; installations</li>
<li>Outlet &amp; switch installation</li>
<li>Ceiling fan &amp; light fixture installation</li>
<li>Smart home wiring &amp; automation</li>
<li>Electrical inspections &amp; code compliance</li>
<li>Emergency electrical repairs</li>
</ul>
<h2>Smart Home Specialists:</h2>
<ul>
<li>Smart switches &amp; dimmers</li>
<li>Security system wiring</li>
<li>Home automation setup</li>
<li>EV charger installation</li>
</ul>
<p><strong>Emergency Electrical: (404) 555-VOLT</strong></p>',
'Licensed Electrical Services - Residential & Commercial', 'Licensed electricians for all electrical needs. Panel upgrades, wiring, outlets.', 'publish', 'closed', 'closed', '', 'electrical', '', '', NOW(), UTC_TIMESTAMP(), '', 0, '', 0, 'page', '', 0);

-- Insert Landscaping Page
INSERT INTO wp_posts (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES
(6, 1, NOW(), UTC_TIMESTAMP(),
'<h1>Professional Landscaping Services</h1>
<p>Transform your outdoor space with expert landscaping and reliable lawn care services.</p>
<h2>Landscaping Services:</h2>
<ul>
<li>Weekly lawn maintenance &amp; mowing</li>
<li>Garden design &amp; installation</li>
<li>Irrigation system installation &amp; repair</li>
<li>Seasonal cleanup &amp; leaf removal</li>
<li>Tree &amp; shrub trimming</li>
<li>Mulching &amp; fertilization</li>
</ul>
<h2>Maintenance Packages:</h2>
<ul>
<li>Weekly lawn care</li>
<li>Bi-weekly maintenance</li>
<li>Seasonal cleanup</li>
<li>Holiday decorating</li>
</ul>
<p><strong>Get Your Quote: (404) 555-LAWN</strong></p>',
'Professional Landscaping & Lawn Care Services', 'Complete landscaping services. Lawn care, garden design, seasonal maintenance.', 'publish', 'closed', 'closed', '', 'landscaping', '', '', NOW(), UTC_TIMESTAMP(), '', 0, '', 0, 'page', '', 0);

-- Insert Appliance Repair Page
INSERT INTO wp_posts (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES
(7, 1, NOW(), UTC_TIMESTAMP(),
'<h1>Fast Appliance Repair Services</h1>
<p>Don''t let broken appliances disrupt your daily routine. Our certified technicians fix all major appliances quickly and affordably.</p>
<h2>Appliances We Repair:</h2>
<ul>
<li>Refrigerators &amp; freezers</li>
<li>Washing machines &amp; dryers</li>
<li>Dishwashers</li>
<li>Ovens, stoves &amp; ranges</li>
<li>Microwaves</li>
<li>Garbage disposals</li>
</ul>
<h2>Major Brands Serviced:</h2>
<p>Whirlpool, GE, Samsung, LG, Frigidaire, Maytag, KitchenAid, Bosch</p>
<p><strong>Same-Day Service: (404) 555-FIXIT</strong></p>',
'Fast Appliance Repair - Same Day Service Available', 'Expert appliance repair for all major brands. Same-day service available.', 'publish', 'closed', 'closed', '', 'appliance-repair', '', '', NOW(), UTC_TIMESTAMP(), '', 0, '', 0, 'page', '', 0);

-- Insert House Cleaning Page  
INSERT INTO wp_posts (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES
(8, 1, NOW(), UTC_TIMESTAMP(),
'<h1>Professional House Cleaning</h1>
<p>Reliable, thorough house cleaning services that give you more time for what matters most.</p>
<h2>Cleaning Services:</h2>
<ul>
<li>Weekly/bi-weekly regular cleaning</li>
<li>Deep cleaning service</li>
<li>Move-in/move-out cleaning</li>
<li>Post-construction cleanup</li>
<li>Holiday &amp; special event cleaning</li>
<li>One-time cleaning service</li>
</ul>
<h2>What''s Included:</h2>
<ul>
<li>All rooms cleaned top to bottom</li>
<li>Kitchen: appliances, counters, sink, floor</li>
<li>Bathrooms: tub, shower, toilet, mirror, floor</li>
<li>Living areas: dusting, vacuuming, mopping</li>
<li>Bedrooms: making beds, dusting, vacuuming</li>
</ul>
<p><strong>Book Your Cleaning: (404) 555-CLEAN</strong></p>',
'Professional House Cleaning Services - Reliable & Affordable', 'Professional house cleaning services. Regular cleaning, deep cleaning, move-in/out.', 'publish', 'closed', 'closed', '', 'cleaning', '', '', NOW(), UTC_TIMESTAMP(), '', 0, '', 0, 'page', '', 0);