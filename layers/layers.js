var wms_layers = [];


        var lyr_OpenTopoMap_0 = new ol.layer.Tile({
            'title': 'OpenTopoMap',
            'opacity': 1.000000,
            
            
            source: new ol.source.XYZ({
            attributions: '<a href="https://www.openstreetmap.org/copyright">Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA)</a>',
                url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png'
            })
        });
var format_sensor_locations_1 = new ol.format.GeoJSON();
var features_sensor_locations_1 = format_sensor_locations_1.readFeatures(json_sensor_locations_1, 
            {dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});
var jsonSource_sensor_locations_1 = new ol.source.Vector({
    attributions: ' ',
});
jsonSource_sensor_locations_1.addFeatures(features_sensor_locations_1);
var lyr_sensor_locations_1 = new ol.layer.Vector({
                declutter: false,
                source:jsonSource_sensor_locations_1, 
                style: style_sensor_locations_1,
                popuplayertitle: 'sensor_locations',
                interactive: true,
                title: '<img src="styles/legend/sensor_locations_1.png" /> sensor_locations'
            });

lyr_OpenTopoMap_0.setVisible(true);lyr_sensor_locations_1.setVisible(true);
var layersList = [lyr_OpenTopoMap_0,lyr_sensor_locations_1];
lyr_sensor_locations_1.set('fieldAliases', {'x': 'x', 'y': 'y', 'friendly_name': 'friendly_name', 'Description': 'Description', });
lyr_sensor_locations_1.set('fieldImages', {'x': 'TextEdit', 'y': 'TextEdit', 'friendly_name': 'TextEdit', 'Description': 'TextEdit', });
lyr_sensor_locations_1.set('fieldLabels', {'x': 'no label', 'y': 'no label', 'friendly_name': 'no label', 'Description': 'no label', });
lyr_sensor_locations_1.on('precompose', function(evt) {
    evt.context.globalCompositeOperation = 'normal';
});