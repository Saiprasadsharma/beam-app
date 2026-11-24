import { Component } from '@angular/core';
import { Beam } from './beam/beam';

@Component({
  selector: 'app-root',
  imports: [Beam],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {}
