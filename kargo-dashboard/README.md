# Kargo Dashboard

This project is a lightweight node.js app that summarizes the current state of Kargo powered projects.  Specially visuallizing the currently deployed version of several projects across their shared environments.

## Visualization


- Project Names are the y-axis row names
- Each row many have an inconsistent number of cells, tied to number of stages in that project
- Order of cells in a row matches the dependecnies defined by Kargo Stages
- Individual cells show the version of that project deployed to that stage. 
- Cell color is a visual color of the version decay (more below)
- The first column in every row is the latest freight version




## Requirements

- Kargo projects must use consistent Stage names
- Customizations and settings live in config.json
- "Version" is the `Tag` of the first matching `image` of the first subscription.


## Version Decay

Version decay is a visual indicator of idle inventory; meaning versions built but not yet delivered into higher environments.




## Configuration

Configuration will include customizable features.

- Projects to include, as a map with indivudal values.
  - Which warehouse (by name) to consider
  - Stages to exclude (regex if prefixed with `regex:` or full match otherwise)
  - Stages to include (regex if prefixed with `regex:` or full match otherwise)
  - Stages will first consider all includes, and then remove any excludes.  Absence of defined includes will include all, and then apply excludes if any.



# Resources

## Kargo Concepts

- Freight is an immutable tuple representing container images and supporting git configurtaion
- Stages define promotions into specific targets
- Promption is an instance of moving freigth into a target
- Warehouses define the source repositories and registries as subsriptions.
- Projects is the container for a pipeline or promotion flow where Warehouse, Freight, Stages, etc live.