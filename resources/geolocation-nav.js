// Shows the visitor's live location on the map. If they're already on/near
// the preserve's trail network, it navigates them in-app by walking the
// actual trails (loaded from layers/trail_network.js). If they're too far
// away to walk (i.e. they'd need to drive), it instead hands them off to
// Google Maps for driving directions to the trailhead parking lot, since
// street routing has no idea about informal trails inside the preserve.
(function () {
    var viewProjection = map.getView().getProjection();

    // How far off the trail network someone can be (in real meters) before
    // we consider them "at the preserve" and switch from driving directions
    // to in-app trail navigation.
    var NEAR_PRESERVE_METERS = 300;

    function haversineMeters(lonLatA, lonLatB) {
        var R = 6371000;
        var toRad = function (d) { return d * Math.PI / 180; };
        var dLat = toRad(lonLatB[1] - lonLatA[1]);
        var dLon = toRad(lonLatB[0] - lonLatA[0]);
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lonLatA[1])) * Math.cos(toRad(lonLatB[1])) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Real-world distance (meters) between two EPSG:3857 map coordinates
    function realMeters(coordA, coordB) {
        return haversineMeters(ol.proj.toLonLat(coordA, viewProjection), ol.proj.toLonLat(coordB, viewProjection));
    }

    function realPathMeters(coordinates) {
        var total = 0;
        for (var i = 0; i < coordinates.length - 1; i++) {
            total += realMeters(coordinates[i], coordinates[i + 1]);
        }
        return total;
    }

    function findTrailheadFeature() {
        var features = lyr_sensor_locations_1.getSource().getFeatures();
        for (var i = 0; i < features.length; i++) {
            var description = features[i].get('Description') || '';
            if (/parking/i.test(description)) { return features[i]; }
        }
        for (var j = 0; j < features.length; j++) {
            if (features[j].get('friendly_name') === 'sensor_3321') { return features[j]; }
        }
        return features[0] || null;
    }
    var trailheadFeature = findTrailheadFeature();

    // David Loyd Davis's backyard sits off in the neighboring road, not on
    // the preserve's trail network, so it's excluded from navigation.
    function isExcludedFromNavigation(feature) {
        var description = feature.get('Description') || '';
        return /david.*backyard/i.test(description) || feature.get('friendly_name') === 'sensor_3212';
    }

    // ---------------------------------------------------------------
    // Basemap: cap OpenTopoMap at its real max zoom (17) so zooming in
    // further reuses/upsamples the last real tile instead of hitting
    // OpenTopoMap's "max zoom / layer = 17" placeholder image, and offer
    // a satellite (Esri World Imagery) alternative for closer-in zoom.
    // ---------------------------------------------------------------
    lyr_OpenTopoMap_0.setSource(new ol.source.XYZ({
        attributions: '<a href="https://www.openstreetmap.org/copyright">Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA)</a>',
        url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
        maxZoom: 17
    }));
    map.getView().setMaxZoom(19);

    var satelliteLayer = new ol.layer.Tile({
        source: new ol.source.XYZ({
            attributions: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            maxZoom: 19
        }),
        visible: false
    });
    map.getLayers().insertAt(1, satelliteLayer);

    var satelliteWrapper = document.createElement('div');
    satelliteWrapper.className = 'ol-control locate-control';
    var satelliteButton = document.createElement('button');
    satelliteButton.type = 'button';
    satelliteButton.title = 'Switch to satellite view';
    satelliteButton.innerHTML = '<i class="fas fa-globe" aria-hidden="true"></i>';
    satelliteWrapper.appendChild(satelliteButton);

    satelliteButton.addEventListener('click', function () {
        var showSatellite = !satelliteLayer.getVisible();
        satelliteLayer.setVisible(showSatellite);
        lyr_OpenTopoMap_0.setVisible(!showSatellite);
        satelliteButton.title = showSatellite ? 'Switch to topo map view' : 'Switch to satellite view';
    });

    // ---------------------------------------------------------------
    // Trail graph: build a routable network out of the trail LineStrings
    // ---------------------------------------------------------------
    var geojsonFormat = new ol.format.GeoJSON();
    var trailFeatures = geojsonFormat.readFeatures(json_trail_network, {
        dataProjection: 'EPSG:4326',
        featureProjection: viewProjection
    });

    var nodeCoords = {};      // key -> [x, y]
    var adjacency = {};       // key -> { neighborKey: distance }
    var segments = [];        // [{a:[x,y], b:[x,y], aKey, bKey}]

    function keyFor(coord) {
        // quantize to 1cm so shared OSM nodes collapse onto the same graph node
        return Math.round(coord[0] * 100) + '_' + Math.round(coord[1] * 100);
    }

    function dist(a, b) {
        var dx = a[0] - b[0], dy = a[1] - b[1];
        return Math.sqrt(dx * dx + dy * dy);
    }

    function addEdge(k1, c1, k2, c2) {
        nodeCoords[k1] = c1;
        nodeCoords[k2] = c2;
        var d = dist(c1, c2);
        adjacency[k1] = adjacency[k1] || {};
        adjacency[k2] = adjacency[k2] || {};
        adjacency[k1][k2] = d;
        adjacency[k2][k1] = d;
    }

    trailFeatures.forEach(function (feature) {
        var geom = feature.getGeometry();
        var lines = geom.getType() === 'MultiLineString' ? geom.getCoordinates() : [geom.getCoordinates()];
        lines.forEach(function (coords) {
            for (var i = 0; i < coords.length - 1; i++) {
                var a = coords[i], b = coords[i + 1];
                var aKey = keyFor(a), bKey = keyFor(b);
                addEdge(aKey, a, bKey, b);
                segments.push({ a: a, b: b, aKey: aKey, bKey: bKey });
            }
        });
    });

    var trailSource = new ol.source.Vector({
        features: trailFeatures,
        attributions: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    var trailLayer = new ol.layer.Vector({
        source: trailSource,
        style: new ol.style.Style({
            stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0)', width: 0 })
        })
    });
    trailLayer.set('interactive', false);
    map.addLayer(trailLayer);

    // Projects `point` onto segment a-b, returns {point, t, d}
    function projectToSegment(point, a, b) {
        var abx = b[0] - a[0], aby = b[1] - a[1];
        var lenSq = abx * abx + aby * aby;
        var t = lenSq === 0 ? 0 : ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / lenSq;
        t = Math.max(0, Math.min(1, t));
        var proj = [a[0] + t * abx, a[1] + t * aby];
        return { point: proj, d: dist(point, proj) };
    }

    // Finds the closest point on the whole trail network to `coord`
    function nearestOnTrail(coord) {
        var best = null;
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            var res = projectToSegment(coord, seg.a, seg.b);
            if (!best || res.d < best.d) {
                best = { point: res.point, d: res.d, seg: seg };
            }
        }
        return best;
    }

    function dijkstra(startKey, endKey, extraAdjacency) {
        var adj = function (k) {
            var base = adjacency[k] || {};
            var extra = extraAdjacency[k];
            if (!extra) { return base; }
            var merged = {};
            for (var n in base) { merged[n] = base[n]; }
            for (var n2 in extra) { merged[n2] = extra[n2]; }
            return merged;
        };

        var dists = {};
        var prev = {};
        var visited = {};
        dists[startKey] = 0;
        var queue = [startKey];

        while (queue.length) {
            // simple O(n) min-extraction; graph is small (a few hundred nodes)
            queue.sort(function (x, y) { return dists[x] - dists[y]; });
            var current = queue.shift();
            if (visited[current]) { continue; }
            visited[current] = true;
            if (current === endKey) { break; }

            var neighbors = adj(current);
            for (var neighborKey in neighbors) {
                if (visited[neighborKey]) { continue; }
                var candidate = dists[current] + neighbors[neighborKey];
                if (dists[neighborKey] === undefined || candidate < dists[neighborKey]) {
                    dists[neighborKey] = candidate;
                    prev[neighborKey] = current;
                    queue.push(neighborKey);
                }
            }
        }

        if (dists[endKey] === undefined) { return null; }
        var path = [endKey];
        while (path[path.length - 1] !== startKey) {
            path.push(prev[path[path.length - 1]]);
        }
        path.reverse();
        return { keys: path, distance: dists[endKey] };
    }

    // Builds a route from `fromCoord` to `toCoord` by snapping each end onto
    // the nearest trail point, then shortest-pathing between those snap points.
    function routeBetween(fromCoord, toCoord) {
        var fromSnap = nearestOnTrail(fromCoord);
        var toSnap = nearestOnTrail(toCoord);
        if (!fromSnap || !toSnap) { return null; }

        var startKey = 'start';
        var endKey = 'end';
        var extraAdjacency = {};
        extraAdjacency[startKey] = {};
        extraAdjacency[endKey] = {};

        function attachSnap(key, snap) {
            var aKey = snap.seg.aKey, bKey = snap.seg.bKey;
            var dA = dist(snap.point, snap.seg.a);
            var dB = dist(snap.point, snap.seg.b);
            extraAdjacency[key][aKey] = dA;
            extraAdjacency[aKey] = extraAdjacency[aKey] || {};
            extraAdjacency[aKey][key] = dA;
            extraAdjacency[key][bKey] = dB;
            extraAdjacency[bKey] = extraAdjacency[bKey] || {};
            extraAdjacency[bKey][key] = dB;
        }
        attachSnap(startKey, fromSnap);
        attachSnap(endKey, toSnap);

        if (dist(fromSnap.point, toSnap.point) < 0.01 && fromSnap.seg === toSnap.seg) {
            // both ends snap to (essentially) the same spot on the same segment
            return {
                coordinates: [fromCoord, fromSnap.point, toCoord],
                distance: dist(fromCoord, fromSnap.point) + dist(toCoord, toSnap.point)
            };
        }

        var result = dijkstra(startKey, endKey, extraAdjacency);
        if (!result) { return null; }

        var coordinates = [fromCoord, fromSnap.point];
        result.keys.forEach(function (key) {
            if (key === startKey || key === endKey) { return; }
            coordinates.push(nodeCoords[key]);
        });
        coordinates.push(toSnap.point, toCoord);

        var totalDistance = dist(fromCoord, fromSnap.point) + result.distance + dist(toSnap.point, toCoord);
        return { coordinates: coordinates, distance: totalDistance };
    }

    // ---------------------------------------------------------------
    // Geolocation: live position + accuracy circle
    // ---------------------------------------------------------------
    var geolocation = new ol.Geolocation({
        trackingOptions: { enableHighAccuracy: true },
        projection: viewProjection
    });

    var accuracyFeature = new ol.Feature();
    geolocation.on('change:accuracyGeometry', function () {
        accuracyFeature.setGeometry(geolocation.getAccuracyGeometry());
    });

    var positionFeature = new ol.Feature();
    positionFeature.setStyle(new ol.style.Style({
        image: new ol.style.Circle({
            radius: 7,
            fill: new ol.style.Fill({ color: '#1a73e8' }),
            stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 })
        })
    }));

    var routeFeature = new ol.Feature();
    routeFeature.setStyle(new ol.style.Style({
        stroke: new ol.style.Stroke({ color: '#ff6d00', width: 5, lineCap: 'round', lineJoin: 'round' })
    }));

    var selectedSensorFeature = null;

    function getUserPosition() {
        return geolocation.getPosition();
    }

    function formatDistance(meters) {
        if (meters < 1000) { return Math.round(meters) + ' m'; }
        return (meters / 1000).toFixed(2) + ' km';
    }

    // ---------------------------------------------------------------
    // Navigation panel: a persistent, fixed panel (not tied to the map's
    // coordinate system) so directions are always clearly visible and
    // never sit on top of the trail route drawn on the map.
    // ---------------------------------------------------------------
    var navPanel = document.getElementById('nav-panel');
    var navPanelTitle = document.getElementById('nav-panel-title');
    var navPanelBody = document.getElementById('nav-panel-body');

    function showNavPanel(title, bodyHtml) {
        if (!navPanel) { return; }
        navPanelTitle.textContent = title;
        navPanelBody.innerHTML = bodyHtml;
        navPanel.classList.add('visible');
    }

    function hideNavPanel() {
        if (!navPanel) { return; }
        navPanel.classList.remove('visible');
    }

    // Decides whether to navigate in-app (on the trail) or hand off to
    // Google Maps for driving directions to the trailhead, then updates the
    // on-map route line and the navigation panel accordingly. The walking
    // distance from the parking lot is always shown, even before the
    // visitor has a location (or is nowhere near the preserve), so they can
    // scope out a hike ahead of time.
    function updateNavigation() {
        updateModeButton();

        if (!selectedSensorFeature) {
            routeFeature.setGeometry(null);
            hideNavPanel();
            return;
        }

        var sensorTitle = selectedSensorFeature.get('Description') ||
            selectedSensorFeature.get('friendly_name') || 'Sensor';
        var sensorCoord = selectedSensorFeature.getGeometry().getCoordinates();

        // Always available as a fallback: the walking route from the parking
        // lot, drawn in orange even before/without the visitor's own location.
        var walkFromTrailheadHtml = '';
        var walkRoute = null;
        if (trailheadFeature) {
            walkRoute = routeBetween(trailheadFeature.getGeometry().getCoordinates(), sensorCoord);
            if (walkRoute) {
                walkFromTrailheadHtml = '<span class="navigate-distance">' +
                    formatDistance(realPathMeters(walkRoute.coordinates)) + ' walk from the parking lot</span>';
            }
        }
        routeFeature.setGeometry(walkRoute ? new ol.geom.LineString(walkRoute.coordinates) : null);

        var userCoord = getUserPosition();

        if (!userCoord) {
            showNavPanel(sensorTitle, walkFromTrailheadHtml +
                '<span class="navigate-note">Shown in orange on the map. Tap "Show my location" for live directions.</span>');
            return;
        }

        var nearestTrailPoint = nearestOnTrail(userCoord);
        var distanceOffTrail = nearestTrailPoint ? realMeters(userCoord, nearestTrailPoint.point) : Infinity;

        if (distanceOffTrail <= NEAR_PRESERVE_METERS) {
            // Close enough to the preserve to walk: navigate on the trail itself,
            // replacing the parking-lot fallback with the live route.
            var route = routeBetween(userCoord, sensorCoord);
            if (route) {
                routeFeature.setGeometry(new ol.geom.LineString(route.coordinates));
                showNavPanel(sensorTitle,
                    '<span class="navigate-distance">' + formatDistance(realPathMeters(route.coordinates)) + ' along the trail</span>' +
                    '<span class="navigate-note">Follow the orange highlighted path on the map.</span>');
            } else {
                showNavPanel(sensorTitle, walkFromTrailheadHtml +
                    '<span class="navigate-note">No trail route found to this sensor.</span>');
            }
        } else if (trailheadFeature) {
            // Too far to walk: hand off to Google Maps for driving directions
            // to the trailhead parking lot (the orange path stays on screen
            // showing the walk once they arrive).
            var trailheadCoord = trailheadFeature.getGeometry().getCoordinates();
            var trailheadLonLat = ol.proj.toLonLat(trailheadCoord, viewProjection);
            var drivingDistance = realMeters(userCoord, trailheadCoord);
            var directionsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' +
                trailheadLonLat[1] + ',' + trailheadLonLat[0] + '&travelmode=driving';
            showNavPanel(sensorTitle,
                walkFromTrailheadHtml +
                '<span class="navigate-note">' + formatDistance(drivingDistance) + ' drive to the preserve</span>' +
                '<a class="navigate-link" href="' + directionsUrl + '" target="_blank" rel="noopener noreferrer">' +
                '<i class="fas fa-car" aria-hidden="true"></i> Drive to trailhead parking</a>' +
                '<span class="navigate-note">Once you arrive, reopen this map to navigate the trail.</span>');
        }
    }

    geolocation.on('change:position', function () {
        var coordinate = geolocation.getPosition();
        positionFeature.setGeometry(coordinate ? new ol.geom.Point(coordinate) : null);
        updateNavigation();
    });

    geolocation.on('error', function (error) {
        window.alert('Unable to determine your location: ' + error.message);
    });

    var locationLayer = new ol.layer.Vector({
        source: new ol.source.Vector({ features: [accuracyFeature, positionFeature, routeFeature] }),
        style: new ol.style.Style({
            fill: new ol.style.Fill({ color: 'rgba(26,115,232,0.15)' }),
            stroke: new ol.style.Stroke({ color: 'rgba(26,115,232,0.6)', width: 1 })
        })
    });
    locationLayer.set('interactive', false);
    map.addLayer(locationLayer);

    // "Locate me" control, styled like the built-in zoom control
    var locateWrapper = document.createElement('div');
    locateWrapper.className = 'ol-control locate-control';
    var locateButton = document.createElement('button');
    locateButton.type = 'button';
    locateButton.title = 'Show my location';
    locateButton.innerHTML = '<i class="fas fa-location-arrow" aria-hidden="true"></i>';
    locateWrapper.appendChild(locateButton);

    locateButton.addEventListener('click', function () {
        geolocation.setTracking(true);
        var coordinate = geolocation.getPosition();
        if (coordinate) {
            positionFeature.setGeometry(new ol.geom.Point(coordinate));
            updateNavigation();
            map.getView().animate({ center: coordinate, zoom: Math.max(map.getView().getZoom(), 18), duration: 400 });
        } else {
            geolocation.once('change:position', function () {
                var c = geolocation.getPosition();
                if (c) {
                    map.getView().animate({ center: c, zoom: Math.max(map.getView().getZoom(), 18), duration: 400 });
                }
            });
        }
    });

    // Mode button: reflects whether the visitor is close enough to the
    // preserve to walk. Shows a car (blue) that opens Google Maps driving
    // directions to the trailhead when they're not there yet, and flips to
    // a foot icon (dark green) once they're at the parking lot/preserve,
    // where in-app trail navigation takes over.
    var modeWrapper = document.createElement('div');
    modeWrapper.className = 'ol-control locate-control';
    var modeButton = document.createElement('button');
    modeButton.type = 'button';
    modeWrapper.appendChild(modeButton);
    var currentMode = null; // 'car' | 'foot' | null (unknown, no location yet)

    function updateModeButton() {
        var userCoord = getUserPosition();
        if (!userCoord) {
            currentMode = null;
            modeButton.innerHTML = '<i class="fas fa-car" aria-hidden="true"></i>';
            modeButton.title = 'Navigate to preserve on Google Maps';
            modeButton.classList.remove('mode-active');
            return;
        }

        var nearestTrailPoint = nearestOnTrail(userCoord);
        var distanceOffTrail = nearestTrailPoint ? realMeters(userCoord, nearestTrailPoint.point) : Infinity;

        if (distanceOffTrail <= NEAR_PRESERVE_METERS) {
            currentMode = 'foot';
            modeButton.innerHTML = '<i class="fas fa-shoe-prints" aria-hidden="true"></i>';
            modeButton.title = 'Walking mode: you\'re at the preserve';
            modeButton.classList.add('mode-active');
        } else {
            currentMode = 'car';
            modeButton.innerHTML = '<i class="fas fa-car" aria-hidden="true"></i>';
            modeButton.title = 'Navigate to preserve on Google Maps';
            modeButton.classList.remove('mode-active');
        }
    }
    updateModeButton();

    modeButton.addEventListener('click', function () {
        if (currentMode === 'foot') {
            var userCoord = getUserPosition();
            if (userCoord) {
                map.getView().animate({ center: userCoord, zoom: Math.max(map.getView().getZoom(), 18), duration: 400 });
            }
            return;
        }
        if (trailheadFeature) {
            var trailheadCoord = trailheadFeature.getGeometry().getCoordinates();
            var trailheadLonLat = ol.proj.toLonLat(trailheadCoord, viewProjection);
            var directionsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' +
                trailheadLonLat[1] + ',' + trailheadLonLat[0] + '&travelmode=driving';
            window.open(directionsUrl, '_blank', 'noopener,noreferrer');
        }
    });

    // Zoom-to-group controls: jump between the Cascade Springs trail sensors
    // and the far-away regulatory/calibration sensors with one click.
    function makeControlButton(iconClass, title, onClick) {
        var wrapper = document.createElement('div');
        wrapper.className = 'ol-control locate-control';
        var button = document.createElement('button');
        button.type = 'button';
        button.title = title;
        button.innerHTML = '<i class="fas ' + iconClass + '" aria-hidden="true"></i>';
        button.addEventListener('click', onClick);
        wrapper.appendChild(button);
        return wrapper;
    }

    var cascadeZoomWrapper = makeControlButton('fa-tree', 'Zoom to Cascade Springs sensors', function () {
        map.getView().fit(lyr_sensor_locations_1.getSource().getExtent(), {
            padding: [60, 60, 60, 60],
            maxZoom: 18,
            duration: 500
        });
    });

    var regulatoryZoomWrapper = makeControlButton('fa-industry', 'Zoom to regulatory sensors', function () {
        map.getView().fit(lyr_regulatory_sensors_1.getSource().getExtent(), {
            padding: [60, 60, 60, 60],
            maxZoom: 16,
            duration: 500
        });
    });

    var topRightContainerDiv = document.getElementById('top-right-container');
    if (topRightContainerDiv) {
        topRightContainerDiv.appendChild(locateWrapper);
        topRightContainerDiv.appendChild(modeWrapper);
        topRightContainerDiv.appendChild(satelliteWrapper);
        topRightContainerDiv.appendChild(cascadeZoomWrapper);
        topRightContainerDiv.appendChild(regulatoryZoomWrapper);
    }

    // Popups anchor above the clicked point (with the CSS triangle pointing
    // down at it) instead of sprawling right/below over the map, so they're
    // far less likely to sit on top of the highlighted trail route.
    overlayPopup.setPositioning('bottom-center');
    overlayPopup.setOffset([0, -15]);

    // Swap in the sensor's own description for the generic layer title, and
    // drive the navigation panel. Registered after qgis2web's own singleclick
    // handlers, so `content` already holds the rendered popup markup.
    map.on('singleclick', function (evt) {
        var sensorFeature = null;
        map.forEachFeatureAtPixel(evt.pixel, function (feature, layer) {
            if (layer === lyr_sensor_locations_1) {
                sensorFeature = feature;
            }
        });

        if (!sensorFeature) {
            selectedSensorFeature = null;
            routeFeature.setGeometry(null);
            hideNavPanel();
            return;
        }

        // show the sensor's own description instead of the generic layer title,
        // and drop the now-redundant Description row further down in the popup
        if (content) {
            var description = sensorFeature.get('Description') || sensorFeature.get('friendly_name') || '';
            content.innerHTML = content.innerHTML
                .replace('<b>sensor_locations</b>', '<b>' + description + '</b>')
                .replace('<tr><td colspan="2">' + description + '</td></tr>', '');
        }

        if (isExcludedFromNavigation(sensorFeature)) {
            selectedSensorFeature = null;
            routeFeature.setGeometry(null);
            showNavPanel(sensorFeature.get('Description') || 'Sensor',
                '<span class="navigate-note">Trail navigation isn\'t available for this location.</span>');
            return;
        }

        selectedSensorFeature = sensorFeature;
        updateNavigation();
    });
})();
