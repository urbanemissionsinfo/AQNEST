# AQ-NEST (Air Quality Network Evaluation & Siting Tool)

AQ-NEST is a web tool designed to estimate how many air quality monitors a region needs based on human population, and to evaluate how well existing or proposed monitor networks cover those people.
You can access this tool here:
1. [India specific tool](https://urbanemissionsinfo.github.io/MonitoringNeeds/) - has pre-loaded CPCB monitors locations.
2. [Global](https://urbanemissionsinfo.github.io/MonitoringNeeds/global.html)

![alt text](data/example.png)

## Objective

The core goal of AQ-NEST is to turn **spatial population distribution** into actionable monitoring requirements.

By overlaying global population datasets with local administrative boundaries or custom-drawn areas, the tool calculates:
1. Total population within a targeted spatial region.
2. Minimum required air quality monitoring stations based on regulatory guidelines.
3. A Network Score evaluating how well a network of stations represents the air breathed by the local population.

## Methodology & Workflow
The web app runs entirely in the browser using raster processing and spatial analysis.

```text
┌──────────────────────────────────────────────┐
│ Spatial Area Selection                       │
│ • Draw Bounding Box / Polygon  (OR)          │
│ • Upload GeoJSON or KML of Admin Layer       │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ LandScan 2024 Population                     │
│ • Intersect selected region with raster      │
│ • Calculate population in the region         │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ Urban Correction Factor                      │
│ • Calculate density ratio                    │
│ • High-Density Cells / Urban Cells           │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ CPCB Monitor Requirement                     │
│ • Compute required monitors                  │
│ • SPM/PM, SO₂, NO₂, and CO                   │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ Station Placement & Score                    │
│ • Place or upload monitor locations          │
│ • Evaluate coverage and distance             │
│ • Calculate Network Score                    │
└──────────────────────────────────────────────┘
```

### Population

Population datasets are taken from [Landscan Global 2024](https://landscan.ornl.gov/). This data is in raster format with spatial resolution of 30 arc seconds (1km at equator). Each pixel has the data on number of people living in that cell.

When an area is defined (via manual bounding box, drawn polygon, or uploaded GeoJSON/KML Administrative boundaries), the tool extracts all underlying raster pixels and sums the total population.

### Urban Correction Factor (UCF)

Not all population density is evenly distributed. To prevent under-estimating monitor needs in heavily clustered urban centers:

1. The tool calculates average population density across non-zero cells in the selected shape.
2. It identifies high-density cells (population > average density) and urban core cells (population > 500 per cell).
3. The Urban Correction Factor (UCF) is computed as:$$\text{UCF} = 1 + \left( \frac{\text{High Density Cells}}{\text{Urban Cells (> 500)}} \right)$$

## Regulatory Minimum Monitor Estimation
Using CPCB (Central Pollution Control Board) guideline formulas, the tool estimates minimum required monitoring stations across pollutants:
1. PM / Suspended Particulate Matter (SPM) - scaled by UCF.
2. Sulfur Dioxide ($\text{SO}_2$)
3. Nitrogen Dioxide ($\text{NO}_2$)
4. Carbon Monoxide ($\text{CO}$)

Background monitoring station counts (5% of SPM monitors) are also automatically calculated as a baseline offset.

## Network Coverage Scores

Users can manually place proposed monitor pins on the map or upload point locations via GeoJSON. Once placed, AQ-NEST evaluates the network using three metrics:
1. **Population Coverage Score (10 pts):** Measures the percentage of the target population living within the effective radius of a monitor ($1\text{ km}$ for high-density areas $>8,000\text{ pop/cell}$, $2\text{ km}$ elsewhere).
2. **Average Nearest-Neighbor Distance Score (10 pts):** Evaluates spatial clustering and inter-station spacing.
3. **Requirement Met Score (10 pts):** Compares the number of placed monitors against CPCB's minimum target.

Overall Network Score is the sum of these three metrics to a maximum of 30.

## Supported Regions

AQ-NEST includes pre-compressed LandScan datasets covering multiple global regions:

1. South Asia
2. South East Asia
3. Central Asia
4. Africa
5. South America
6. Central America

## Tech Stack

1. **Frontend**: Vanilla HTML5, CSS3 (Custom design system).
2. **Mapping**: Leaflet.js (Tiles & Vector layers).
3. **Spatial Processing**: GeoTIFF.js (Browser-side raster parsing), toGeoJSON (KML parsing), D3.js.

--- 
Please refer to our course tutorial [How many monitors are needed in an airshed?](https://urbanemissionsinfo.github.io/AQCourse/notebooks/How_many_monitors_needed.html) for more details.

This tool is built with the help of `Claude Sonnet 4.6` and `Gemini 3.1 Pro`