# Printer Fleet Operations

Language for the workshop's printer dashboard, its managed equipment, and the operation of printing. Definitions describe the domain; the specification contains requirements and implementation decisions.

## Services and configuration

**Workshop Printing**:
The workshop service that makes physical printed parts available to its users.

**Printer Fleet Operations**:
The capability to understand, monitor and operate the workshop's printers and their supporting equipment.

**Printer Dashboard**:
The application through which a user views the fleet and performs supported printer operations.

**Service instance**:
A particular deployed instance of an application or other service realization, such as the workshop's production dashboard.
_Avoid_: Calling an individual physical printer a dashboard service instance.

**Configuration item (CI)**:
A managed item whose identity, configuration or relationships matter to delivering the workshop service.
_Avoid_: Using a temperature sample, job or command as a CI.

**Configuration baseline**:
A recorded, reviewed configuration against which later configuration or observed differences can be assessed.

**Fleet**:
The printers enrolled for management in this workshop, including temporarily unavailable equipment.
_Avoid_: Treating only currently connected printers as the fleet.

**Printer**:
An individually identified physical printing machine, independent of its name, address, connection or current job.

**Printer model**:
A manufacturer's type of machine, shared by multiple individual printers.
_Avoid_: Using the model name as an individual printer's identity.

**Endpoint**:
A network destination through which a printer, camera or host can be reached.
_Avoid_: Treating an IP address as permanent equipment identity.

**Host**:
A computer that runs the dashboard or a printer's control software.

**Capability**:
A specific reading or operation a printer connection can provide, qualified by its current availability and the evidence for its support.
_Avoid_: Inferring complete support from a successful connection.

## Observations and printing

**Observation**:
A timestamped reading or report from an identified source about a printer or supporting item.

**Connection state**:
The current condition of communication with a printer, independently of what the last print was doing.

**Job**:
One execution of a print on one printer; repeating the same file produces another job.
_Avoid_: Equating a filename, model file or order with a job.

**Job state**:
The reported stage or outcome of a particular printing execution.
_Avoid_: Using a connection failure as proof that a print failed.

**Freshness**:
Whether an observation is recent enough for its intended display or control decision.
_Avoid_: Treating browser refresh time as printer observation time.

**Command**:
A user's request for a supported operation on a particular printer and, where relevant, its current job.

**Command outcome**:
The recorded result of attempting a command, including an unknown outcome when delivery or resulting state cannot be established.
_Avoid_: Treating request acceptance as proof of physical execution.

**Bed clearance**:
An operator's confirmation that a build surface has been prepared for a particular subsequent dispatch.
_Avoid_: Inferring an empty bed from a completed job.

**Overlay**:
A presentation of printer information intended for use as an OBS source.

## Operations

**Event**:
A recorded state change or occurrence relevant to understanding or operating the fleet.
_Avoid_: Treating every event as an incident.

**Incident**:
An unplanned interruption or degradation of an expected workshop service that needs restoration.

**Problem**:
A cause or potential cause of incidents tracked for investigation and lasting improvement.

**Change**:
A managed alteration that can affect a service, its configuration or its supporting equipment.
_Avoid_: Requiring a separate change record for every routine printer command.

**Maintenance record**:
A record of planned or completed care of an identified item, including its evidence and outcome.

**Support evidence**:
The source and scope of a compatibility claim, distinguishing documented behavior, simulated verification and physical verification.
_Avoid_: Treating a simulator result as physical qualification.
