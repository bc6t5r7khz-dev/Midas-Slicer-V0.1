# MCT Section Lab Vocabulary

This glossary defines the terms used in the application and in future change requests. Each term is intended to name one specific idea.

## Project and concrete model

- **Project** — The complete saved workspace: imported model, setup, planes, slices, views, rebar runs, groups, colors, and parameters.
- **MCT file** — A MIDAS Civil text export used to import nodes and structural elements.
- **Project file** — The MCT Section Lab export used to resume work. It is not intended for re-import into MIDAS.
- **Node** — A model point with an ID and three coordinates.
- **Element** — A MIDAS structural item defined by connected nodes.
- **Element skin** — The collection of imported element faces used to represent the concrete boundary.
- **Concrete skin** — The visible shaded surface of the confirmed concrete volume.
- **Concrete volume** — The solid region enclosed by the accepted boundary faces.
- **Face** — One bounded surface of the concrete volume.
- **Perimeter** — A closed outline produced where a plane intersects the concrete volume.
- **Outer perimeter** — The outline of the exterior concrete boundary on a section.
- **Inner perimeter** — An outline around a void, opening, or hollow region on a section.
- **Offset perimeter** — A snap guide created a specified distance inside a perimeter.
- **Cover** — The distance from a concrete face to the rebar placement guide.
- **Model centroid** — The calculated center of the imported model, used to establish consistent positive plane directions.
- **Model units** — The coordinate units contained in the imported MCT file before scale is defined.
- **Scale** — The conversion between model units and inches, established from a known node-to-node distance.

## Setup and coordinates

- **Setup** — The ordered process of importing the model, defining its volume, floor plane, X axis, and scale.
- **Floor plane** — The selected model face used to establish the project's horizontal reference.
- **Origin** — The first node chosen when defining the X axis.
- **Positive X direction** — The direction from the first X-axis node to the second.
- **Local coordinate system** — The project X, Y, and Z frame calculated from the floor plane and X direction.
- **Object coordinates** — Geometry stored relative to the model itself so it remains attached when the local coordinate system changes.

## Planes, slicing, and views

- **Plane** — A named, colored, movable reference surface used for slicing and rebar layout.
- **Plane origin** — The saved point where a plane was originally created.
- **Plane normal** — The perpendicular direction that determines the plane's orientation and movement axis.
- **Plane position** — The current signed distance of a plane from its origin.
- **Top Horizontal plane** — The automatically created horizontal plane at the model's highest extent.
- **Active plane** — The plane currently selected for slicing or rebar work.
- **Starting plane** — The plane on which the original bar shape is drawn.
- **Target plane** — A different plane selected as the destination of a splayed bar run.
- **Section** — The two-dimensional intersection of a plane with the concrete volume.
- **Slice** — A saved section at a particular plane position and viewing direction.
- **Slice direction** — The side of the plane retained and displayed after cutting.
- **Throw depth** — The distance behind a slice within which parallel rebar is projected into the reinforcing section view.
- **Reinforcing section view** — A view perpendicular to a slice in which crossing bars appear as circles and nearby parallel bars appear as projected bar lines.
- **Saved view** — A slice with stored camera orientation and display settings.
- **Display Rebar** — Shows or hides reinforcement in the slicing viewport.
- **Line and Bar** — Shows the concrete outline and rebar without shaded concrete faces.

## Rebar shape and run

- **Bar** — One physical reinforcing rod.
- **Bar shape** — The connected line segments defining one bar's centerline on its starting plane.
- **Bar vertex** — A point at which a bar starts, ends, or changes direction.
- **Bar segment** — The straight portion between two consecutive bar vertices.
- **Terminal point** — The last vertex drawn in a bar shape.
- **Actual bar diameter** — The rendered rod diameter associated with the selected bar number.
- **Bar number** — The standard reinforcing size designation, such as #5 or #8.
- **Minimum bend radius** — The smallest permitted centerline radius applied at a bar corner for the selected bar number.
- **Bar mark** — The full identifier made from bar number, series, and suffix, such as #5101E.
- **Series** — The numeric portion of the bar mark that normally increments for each new run.
- **Suffix** — The optional ending of a bar mark, such as E for epoxy coated.
- **Bar run** — A set of repeated bars created from one bar shape and one spacing path.
- **Reference bar** — An existing bar run selected as the basis of a lapped bar.
- **Lapped bar** — A new run placed beside and overlapping a reference run.
- **Lap snap point** — A blue point located a specified distance from an end of the reference bar.
- **Bar group** — A named folder used to organize and collectively show or hide bar runs.
- **Nominal spacing** — The requested center-to-center distance between bars.
- **Calculated spacing** — The actual spacing after the application fits bars between the first and final path locations.
- **Bar quantity** — The number of physical bars generated in a run.

## Distribution and advanced geometry

- **Spacing path** — The ordered path along which copies of the bar shape are distributed.
- **Path anchor** — A selected point that fixes the spacing path to a bar or section.
- **First path anchor** — The starting point of the spacing path; it must lie on the drawn bar shape.
- **End path anchor** — The final point of the spacing path.
- **Keypoint** — Any anchor that forms a vertex of a multipoint spacing path.
- **Additional keypoint** — A new spacing-path vertex inserted after the current final keypoint.
- **Path preview** — The gold line showing all confirmed keypoints plus the live segment from the last keypoint to the cursor.
- **Distribution direction** — The direction in which repeated copies advance along a straight spacing path.
- **Splayed run** — A run whose bars fan from the starting plane toward a different target plane.
- **Splay anchor** — The point on each bar that remains on the spacing path while the bar rotates through the fan.
- **Splay count** — The number of bars at the end of the run that participate in the splay; it may also be all bars.
- **Varying-length run** — A run in which the terminal point follows a separate endpoint path, changing bar length through the run.
- **Endpoint path** — The path followed by the terminal point of a varying-length bar run.
- **Start endpoint anchor** — The yellow endpoint-path control for the first bar in a varying-length run.
- **End endpoint anchor** — The cyan endpoint-path control for the last bar in a varying-length run.
- **Additional vertex** — An intermediate endpoint-path control located by Run %.
- **Run %** — The location of an additional endpoint vertex between the first and last bars: 0% is the first bar and 100% is the last.

## Snapping and interaction

- **Free placement** — Placing a point anywhere on the active drawing plane, independent of concrete visibility or snap guides.
- **Vertex snap** — A strong snap to a displayed guide, perimeter, bar, or lap snap vertex.
- **Line snap** — A gentler snap to any point along a displayed guide line.
- **Axis snap** — Automatic horizontal or vertical alignment when a segment is within five degrees of either direction on the drawing plane.
- **Whole-inch length snap** — Holding Shift while drawing rounds the live segment length to the nearest whole inch without changing its direction.
- **Segment-length HUD** — The gold cursor label showing the live segment length and whether whole-inch snapping is active.
- **Shift-click node snap** — Moves the active rebar section or target plane to the selected node's position.
- **Shift+Arrow movement** — Moves the active section by exactly one primary offset increment, provided the full increment stays within its limits.
- **Selected** — An item chosen for an operation; selected geometry is highlighted in the viewport.
- **Hovered** — An item currently under the pointer; hover highlighting previews what a click will select.
- **Preview** — Temporary geometry showing the result of the current pointer location before confirmation.
- **Confirm** — Accept the current workflow step without necessarily changing saved geometry.
- **Update** — Replace saved geometry or settings with edited values.
- **Cancel** — Leave the active step without saving its unconfirmed changes.
- **Undo** — Reverse the most recent supported operation.

## Output

- **Rebar quantity export** — A spreadsheet listing bar marks, quantities, sizes, lengths, and size totals.
- **2D section DXF** — A drawing of the active reinforcing section with concrete outlines, projected bars, and actual-diameter crossing-bar circles.
- **3D model DXF** — A three-dimensional export containing the concrete skin and rebar centerline geometry.
