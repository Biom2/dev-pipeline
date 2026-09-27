# Masdar — Development Pipeline

Site statique qui suit les projets en développement (origination, développement, bid, financement) à partir du fichier **BPD project summary** publié sur Azure Blob Storage. Les données sont rafraîchies chaque matin à 6h (heure d'Abu Dhabi). Le style reprend celui du *Portfolio Asset Tool & Digital Twin*.

## Vues

| Vue | Contenu |
|---|---|
| **Overview** | KPIs (projets, GW AC/DC, capacité nette Masdar, BESS, valeur), pipeline par stade et sous-stade, capacité par technologie, pays ou région, structure des deals, derniers changements, qualité des données |
| **Projects** | Tableau filtrable et triable. Le bouton **Columns** permet d'afficher n'importe lequel des 35 champs du CSV, à côté des valeurs harmonisées. On peut exporter la vue filtrée ou télécharger le CSV source |
| **Map** | Carte Leaflet. Les marqueurs pleins utilisent les coordonnées GPS ; les marqueurs pointillés n'ont pas de GPS et sont placés au centre du pays |
| **Status & financing** | Tableau par stade (sous-stade, statut EPC, dette/equity, part Masdar, budget) et tableau financement (prêteurs, actionnaires, budget, valeur, tarif) |
| **Daily changes** | Écarts entre deux snapshots successifs : projets ajoutés ou retirés, changements de stade, champs modifiés (ancienne → nouvelle valeur) |
| **Data quality** | Anomalies relevées dans le fichier source (textes du template laissés en place, unités incohérentes, coordonnées manquantes…), à corriger à la source |
| **Fiche projet** | Résumé, **tous les champs du CSV** (valeur source et valeur harmonisée), historique des changements du projet, notes qualité |

## Fonctionnement

```
Azure Blob (CSV) ──► GitHub Action (tous les jours à 02:00 UTC)
                        └─ scripts/build_data.py
                             ├─ site/data/history/AAAA-MM-JJ.csv   snapshot brut, créé seulement si les données changent
                             ├─ site/data/history/index.json       liste des snapshots et date du dernier contrôle
                             ├─ site/data/latest.json              projets harmonisés (régénéré)
                             └─ site/data/changes.json             écarts d'un jour à l'autre (régénéré)
                     ──► GitHub Pages (dossier site/)
```

- **Harmonisation** : les variantes d'orthographe des stades, sous-stades, technologies, pays et régions sont listées dans [`config/mappings.json`](config/mappings.json). Si une nouvelle variante apparaît, elle est signalée dans *Data quality* et il suffit de l'ajouter à ce fichier. Les villes saisies dans le champ région (Midelt, Madina) sont conservées telles quelles.
- **Correspondance des stades** : Origination → *Early* · Development → *Advanced* · Bid → *Bid* · Financing / Closing / Financial Close → *Committed*.
- **Coordonnées manquantes** : le projet est placé au centre du pays, défini dans [`config/countries.json`](config/countries.json).
- **Chiffres** : ils sont recalculés à partir du texte saisi. Par exemple « 1.042 bn » donne 1 042 M$, et « 2 projects (1300 MW and 900 MW) » donne 2 200 MW. Quand le résultat diffère de la colonne `_num` de la source, l'écart est signalé.
- **Tarifs** : les unités ne sont pas homogènes dans la source. L'estimation en US cents/kWh est indicative et la valeur source reste toujours affichée.
- **Échec du téléchargement** (jeton SAS expiré, par exemple) : le site est quand même republié avec le dernier snapshot, un badge « Not refreshed since… » s'affiche et le workflow passe en échec, ce qui déclenche un email GitHub.

## Mise en ligne sur GitHub

1. Créer un dépôt (privé de préférence : sur un compte gratuit, le site Pages reste public, mais le code, l'historique et le secret ne le sont pas).
2. Pousser ce dossier :
   ```bash
   git remote add origin https://github.com/<compte>/<repo>.git
   git push -u origin main
   ```
3. **Settings → Secrets and variables → Actions → New repository secret**
   - Nom : `CSV_URL`
   - Valeur : l'URL complète du CSV, jeton SAS compris.
4. **Settings → Pages → Build and deployment → Source : GitHub Actions**.
5. **Actions → Daily refresh & deploy → Run workflow** pour la première publication. Ensuite, le workflow tourne tout seul chaque jour.

> ⚠️ Le jeton SAS actuel expire le **15/01/2027**. Pensez à mettre à jour le secret `CSV_URL` avant cette date.

## En local

```bash
python3 scripts/build_data.py --file export.csv          # à partir d'un fichier local
CSV_URL='https://…' python3 scripts/build_data.py         # à partir d'Azure
python3 scripts/build_data.py --rebuild                  # régénère le JSON à partir du dernier snapshot
python3 -m http.server 8000 --directory site             # puis ouvrir http://localhost:8000
```

Seule la bibliothèque standard Python 3.9+ est nécessaire. Le site n'a pas d'étape de build : HTML, CSS et JavaScript simples, avec Leaflet chargé depuis un CDN.

## Passage sur Azure (plus tard)

Le même dossier `site/` peut être déployé sur **Azure Static Web Apps**, qui permet de restreindre l'accès aux comptes Masdar via Entra ID (`staticwebapp.config.json`). Le rafraîchissement peut rester dans GitHub Actions (déploiement avec `Azure/static-web-apps-deploy`) ou passer dans une Azure Function planifiée. L'accès au blob pourra alors se faire par managed identity plutôt que par jeton SAS.
