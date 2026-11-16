// Jeux de données factices au format des vraies APIs.
export const IRVE_STATIC_CSV = [
  'nom_amenageur,nom_operateur,nom_enseigne,id_station_itinerance,nom_station,adresse_station,coordonneesXY,id_pdc_itinerance,puissance_nominale,prise_type_2,prise_type_combo_ccs,prise_type_chademo,gratuit,paiement_acte,paiement_cb,tarification,condition_acces,horaires,date_maj,consolidated_longitude,consolidated_latitude,consolidated_code_postal,consolidated_commune',
  // station Lyon : 2 PDC CHAdeMO + 1 PDC Type 2 seul
  'Aménageur A,Ionity,Ionity,FRION1,Lyon Confluence,"12 cours Charlemagne, Lyon","[4.8170, 45.7430]",FRION1E1,50,false,true,true,false,true,true,"0,59 €/kWh, ""tarif ad hoc""",Accès libre,24/7,2026-10-01,4.8170,45.7430,69002,Lyon',
  'Aménageur A,Ionity,Ionity,FRION1,Lyon Confluence,"12 cours Charlemagne, Lyon","[4.8170, 45.7430]",FRION1E2,100000,false,true,True,false,true,true,"0,59 €/kWh, ""tarif ad hoc""",Accès libre,24/7,2026-10-01,4.8170,45.7430,69002,Lyon',
  'Aménageur A,Ionity,Ionity,FRION1,Lyon Confluence,"12 cours Charlemagne, Lyon","[4.8170, 45.7430]",FRION1E3,22,true,false,false,false,true,true,,Accès libre,24/7,2026-10-01,4.8170,45.7430,69002,Lyon',
  // station sans colonnes consolidées : coordonnées depuis coordonneesXY
  'Commune B,Freshmile,,FRFR1,Mairie de Villeurbanne,1 place Lazare Goujon,"[4.8800,45.7660]",FRFR1E1,50,false,false,1,true,false,false,,Accès libre,,2026-09-01,,,,',
  // station sans CHAdeMO : ignorée
  'Commune C,Op C,,FRNO1,Parking,rue X,"[4.85,45.75]",FRNO1E1,22,true,false,false,false,true,true,0.30€/kWh,,,2026-09-01,4.85,45.75,69003,Lyon',
].join('\n');

export const IRVE_DYNAMIC_CSV = [
  'id_pdc_itinerance;etat_pdc;occupation_pdc;horodatage;etat_prise_type_2;etat_prise_type_combo_ccs;etat_prise_type_chademo;etat_prise_type_ef',
  'FRION1E1;en_service;libre;2026-11-16T12:00:00+01:00;;fonctionnel;fonctionnel;',
  'FRION1E2;en_service;occupe;2026-11-16T12:05:00+01:00;;fonctionnel;fonctionnel;',
  'FRFR1E1;hors_service;inconnu;2026-11-16T11:00:00+01:00;;;hors_service;',
].join('\n');

export const OCM_RESPONSE = [
  {
    ID: 1001,
    UsageCost: '0,45 €/kWh + 0,10 €/min',
    UsageType: { Title: 'Public - Pay At Location', IsPayAtLocation: true },
    OperatorInfo: { Title: 'Ionity' },
    StatusType: { IsOperational: true },
    AddressInfo: { Title: 'IONITY Lyon', AddressLine1: '12 Cours Charlemagne', Town: 'Lyon', Postcode: '69002', Latitude: 45.7432, Longitude: 4.8171, Country: { ISOCode: 'FR' } },
    Connections: [
      { ConnectionTypeID: 2, PowerKW: 50, Quantity: 2 },
      { ConnectionTypeID: 33, ConnectionType: { Title: 'CCS (Type 2)' }, PowerKW: 350, Quantity: 4 },
    ],
  },
  {
    ID: 2002,
    UsageCost: 'Free',
    UsageType: { Title: 'Public' },
    OperatorInfo: { Title: 'Allego' },
    AddressInfo: { Title: 'Allego Liège', AddressLine1: 'Rue de Fragnée 1', Town: 'Liège', Postcode: '4000', Latitude: 50.62, Longitude: 5.56, Country: { ISOCode: 'BE' } },
    Connections: [{ ConnectionTypeID: 2, PowerKW: 50, Quantity: 1 }],
  },
  {
    ID: 3003,
    AddressInfo: { Title: 'Borne Type 2', Latitude: 45.74, Longitude: 4.82 },
    Connections: [{ ConnectionTypeID: 25, ConnectionType: { Title: 'Type 2 (Socket Only)' }, PowerKW: 22 }],
  },
];

export const OVERPASS_RESPONSE = {
  elements: [
    { type: 'node', id: 11, lat: 45.7431, lon: 4.8169, tags: { amenity: 'charging_station', 'socket:chademo': '2', 'socket:chademo:output': '50 kW', 'socket:type2_combo': '2', 'socket:type2_combo:output': '150 kW', operator: 'Ionity', fee: 'yes', charge: '0.59 EUR/kWh' } },
    { type: 'way', id: 22, center: { lat: 50.85, lon: 4.35 }, tags: { amenity: 'charging_station', 'socket:chademo': '1', name: 'Bruxelles Gare', fee: 'no', 'addr:city': 'Bruxelles' } },
    { type: 'node', id: 33, lat: 50.86, lon: 4.36, tags: { amenity: 'charging_station', 'socket:chademo': 'no' } },
  ],
};

export const GEOPF_RESPONSE = { features: [{ geometry: { coordinates: [4.8357, 45.764] }, properties: { label: 'Lyon', type: 'municipality' } }] };
export const PHOTON_RESPONSE = {
  features: [
    { geometry: { coordinates: [4.8357, 45.764] }, properties: { name: 'Lyon', countrycode: 'FR', country: 'France' } },
    { geometry: { coordinates: [5.57, 50.63] }, properties: { name: 'Liège', city: 'Liège', postcode: '4000', countrycode: 'BE', country: 'Belgique' } },
  ],
};
